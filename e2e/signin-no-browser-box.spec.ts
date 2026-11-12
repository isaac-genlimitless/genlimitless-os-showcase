// The browser's own login box must never appear. nginx used to put HTTP basic auth in front of the OS
// ("satisfy any"), so any request sent without the session cookie (Safari and the home-screen app fetch the tab
// icon without cookies) got a 401 + WWW-Authenticate and the browser popped up its dialog on every reload
// (2026-11-05). Now: session only, and no session → the OS's own /login page (pages) or a plain 401 (API).
import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { decide, type PolicyInput } from "../src/lib/auth/policy";
import { safeNext } from "../src/lib/auth/next-url";

const CONFS = ["bridge/nginx-os-genlimitless.conf", "bridge/nginx-glos-os.conf"].map((f) => path.join(__dirname, "..", f));
const enforced = (p: string): PolicyInput => ({ path: p, method: "GET", headers: { host: "os.example", "x-forwarded-for": "203.0.113.9" }, enrolled: true, enforce: true, breakGlass: false, sessionValid: false });

test("nginx sites: no basic auth, failed session → OS sign-in, sign-in page + icons public", () => {
  for (const f of CONFS) {
    const conf = fs.readFileSync(f, "utf8");
    expect(conf, f).not.toMatch(/^\s*auth_basic\s+"/m); // the directive that makes browsers show their box
    expect(conf, f).not.toMatch(/^\s*satisfy any;/m);
    expect(conf, f).not.toMatch(/auth_basic_user_file/);
    expect(conf, f).toContain("auth_request /_glos_session_check;");
    expect(conf, f).toContain("error_page 401 = @glos_signin;");
    expect(conf, f).toMatch(/location @glos_signin \{[\s\S]*?return 302 \/login\?next=\$request_uri;/);
    const m = conf.match(/location ~ "(\^\/\(login[^"]+)" \{/);
    expect(m, `public sign-in location in ${f}`).toBeTruthy();
    const re = new RegExp(m![1]);
    for (const p of ["/login", "/api/auth/login", "/api/auth/verify", "/api/auth/resend", "/favicon.ico", "/icon.png", "/apple-icon.png", "/robots.txt"]) {
      expect(re.test(p), p).toBe(true);
      expect(decide(enforced(p)), `app policy agrees on ${p}`).toBe("allow");
    }
    for (const p of ["/loginx", "/login/../api/chat", "/api/auth/check", "/api/auth/setup", "/today", "/api/chat", "/icon.pngx"]) expect(re.test(p), p).toBe(false);
  }
});

test("the patcher edits a live (certbot) file in place, keeps TLS lines, and is idempotent", () => {
  const live = `server {
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/os.example.com/fullchain.pem; # managed by Certbot
    server_name os.example.com;
    satisfy any;
    auth_basic "GenLimitless OS";
    auth_basic_user_file /etc/nginx/glos.htpasswd;
    auth_request /_glos_session_check;
    location = /_glos_session_check {
        internal;
        proxy_pass http://127.0.0.1:3100/api/auth/check;
    }
    location / { proxy_pass http://127.0.0.1:3100; }
}
`;
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "glos-nginx-")), "site.conf");
  fs.writeFileSync(tmp, live);
  const script = path.join(__dirname, "../bridge/nginx-signin.py");
  execFileSync("python3", [script, tmp]);
  const once = fs.readFileSync(tmp, "utf8");
  expect(once).toContain("# managed by Certbot");
  expect(once.match(/managed by Certbot/g)).toHaveLength(2);
  expect(once).not.toMatch(/^\s*auth_basic\s+"/m);
  expect(once).not.toMatch(/satisfy any/);
  expect(once).toContain("error_page 401 = @glos_signin;");
  expect(execFileSync("python3", [script, tmp]).toString()).toContain("already patched");
  expect(fs.readFileSync(tmp, "utf8")).toBe(once);
});

// The live server (2026-11-05) still had the older basic-auth-ONLY sites: no auth_request at all. The patcher
// must swap basic auth for the session check, keep every existing exception public, and open nothing else.
test("the patcher converts an older basic-auth-only site to the session check", () => {
  const live = `server {
    server_name os.example.com;
    auth_basic "GenLimitless OS";
    auth_basic_user_file /etc/nginx/glos.htpasswd;
    location ~ "^/share/[A-Za-z0-9_-]{32}$" {
        auth_basic off;
        proxy_pass http://127.0.0.1:3100;
    }
    location = /api/job-engine/inbox {
        auth_basic off;
        proxy_pass http://127.0.0.1:3100;
    }
    location / { proxy_pass http://127.0.0.1:3100; }
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/os.example.com/fullchain.pem; # managed by Certbot
}
server {
    if ($host = os.example.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot
    listen 80;
    server_name os.example.com;
    return 404; # managed by Certbot
}
`;
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "glos-nginx-")), "site.conf");
  fs.writeFileSync(tmp, live);
  const script = path.join(__dirname, "../bridge/nginx-signin.py");
  execFileSync("python3", [script, tmp]);
  const once = fs.readFileSync(tmp, "utf8");
  expect(once.match(/managed by Certbot/g)).toHaveLength(live.match(/managed by Certbot/g)!.length);
  expect(once).not.toMatch(/^\s*auth_basic\s+"/m);
  expect(once).not.toMatch(/auth_basic_user_file/);
  expect(once.match(/^\s*auth_request \/_glos_session_check;/gm)).toHaveLength(1);
  expect(once.match(/^\s*error_page 401 = @glos_signin;/gm)).toHaveLength(1);
  expect(once.match(/location = \/_glos_session_check \{/g)).toHaveLength(1);
  expect(once).toContain("proxy_pass http://127.0.0.1:3100/api/auth/check;");
  expect(once.match(/location \^~ \/_next\/static\/ \{/g)).toHaveLength(1);
  // Each old exception stays public, now for the session check too.
  expect(once.match(/auth_basic off;\n\s*auth_request off;/g)).toHaveLength(2);
  // The catch-all location did not become public.
  expect(once).toMatch(/location \/ \{ proxy_pass http:\/\/127\.0\.0\.1:3100; \}/);
  // The :80 redirect block is untouched.
  expect(once.slice(once.lastIndexOf("server {"))).toBe(live.slice(live.lastIndexOf("server {")));
  expect(execFileSync("python3", [script, tmp]).toString()).toContain("already patched");
  expect(fs.readFileSync(tmp, "utf8")).toBe(once);
});

test("repo nginx sites have no duplicate locations (nginx refuses them)", () => {
  for (const f of CONFS) {
    const locs = (fs.readFileSync(f, "utf8").match(/^\s*location [^{]+\{/gm) || []).map((l) => l.trim());
    expect(locs.filter((l, i) => locs.indexOf(l) !== i), f).toEqual([]);
  }
});

test("after signing in you land back where you were, never on another site", () => {
  expect(safeNext("?next=/the-creation/x?sandbox=3&a=vision")).toBe("/the-creation/x?sandbox=3&a=vision"); // from nginx (raw)
  expect(safeNext("?next=%2Fthe-creation%2Fx%3Fsandbox%3D3%26a%3Dvision")).toBe("/the-creation/x?sandbox=3&a=vision"); // from the app (encoded)
  expect(safeNext("")).toBe("/");
  for (const bad of ["?next=//evil.example", "?next=https://evil.example", "?next=%2F%2Fevil.example", "?next=/\\evil.example", "?next=/login", "?next=%E0%A4%A"]) {
    expect(safeNext(bad), bad).toBe("/");
  }
});
