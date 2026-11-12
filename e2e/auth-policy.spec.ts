import { test, expect } from "@playwright/test";
import { decide, toHeaderMap, isLoopback, sameOrigin, type HeaderMap, type PolicyInput } from "../src/lib/auth/policy";
const ext: HeaderMap = { host: "os.2-28-224-18.sslip.io", "x-forwarded-for": "203.0.113.9", accept: "text/html" };
function input(over: Partial<PolicyInput>): PolicyInput { return { path: "/", method: "GET", headers: ext, enrolled: true, enforce: true, breakGlass: false, sessionValid: false, ...over }; }
test("nothing is enforced until enrolled and switched on", () => {
  expect(decide(input({ enrolled: false }))).toBe("allow");
  expect(decide(input({ enforce: false }))).toBe("allow");
  expect(decide(input({ breakGlass: true }))).toBe("allow");
});
test("enforced: pages go to login, APIs get 401, public paths stay open", () => {
  expect(decide(input({}))).toBe("login_redirect");
  expect(decide(input({ path: "/api/schools" }))).toBe("unauthorized");
  expect(decide(input({ path: "/login" }))).toBe("allow");
  expect(decide(input({ path: "/api/auth/verify", method: "POST" }))).toBe("allow");
  expect(decide(input({ path: "/_next/static/chunks/a.js" }))).toBe("allow");
  expect(decide(input({ sessionValid: true }))).toBe("allow");
});
test("loopback bypass needs a loopback Host and no X-Forwarded-For", () => {
  expect(isLoopback({ host: "127.0.0.1:3100" })).toBe(true);
  expect(isLoopback({ host: "localhost:3100" })).toBe(true);
  expect(isLoopback({ host: "127.0.0.1:3100", "x-forwarded-for": "203.0.113.9" })).toBe(false);
  expect(isLoopback({ host: "os.2-28-224-18.sslip.io" })).toBe(false);
  expect(decide(input({ path: "/api/health", headers: { host: "127.0.0.1:3100" } }))).toBe("allow");
});
test("cross-site writes are refused even with a session", () => {
  const cross: HeaderMap = { ...ext, origin: "https://evil.example" };
  const same: HeaderMap = { ...ext, origin: "https://os.2-28-224-18.sslip.io" };
  expect(sameOrigin(cross)).toBe(false);
  expect(sameOrigin(same)).toBe(true);
  expect(sameOrigin({ ...ext, "sec-fetch-site": "cross-site" })).toBe(false);
  expect(decide(input({ method: "POST", path: "/api/schools", sessionValid: true, headers: cross }))).toBe("forbidden");
  expect(decide(input({ method: "POST", path: "/api/schools", sessionValid: true, headers: same }))).toBe("allow");
});
const viaNginx: HeaderMap = { host: "os.2-28-224-18.sslip.io", "x-forwarded-for": "203.0.113.9" };
const noXff: HeaderMap = { host: "os.2-28-224-18.sslip.io" };
const gatedPages = ["/security", "/security/", "/analytics", "/", "/Login", "/login/", "/_next/image", "/_next/data/x/security.json", "/favicon.icox"];
const gatedApis = ["/api/auth/security", "/api/chat", "/api/chat/threads", "/api/analytics", "/api/analytics/jobs", "/api/uploads/a.png", "/api/files/1/raw", "/api/auth/setup", "/api/google/callback", "/api/email-drafts"];
test("enforced: every non-public page redirects, with and without XFF", () => {
  for (const headers of [viaNginx, noXff]) for (const path of gatedPages) {
    expect(decide(input({ path, headers })), path).toBe("login_redirect");
  }
});
test("enforced: every non-public API is 401, with and without XFF", () => {
  for (const headers of [viaNginx, noXff]) for (const method of ["GET", "POST"]) for (const path of gatedApis) {
    expect(decide(input({ path, method, headers })), `${method} ${path}`).toBe("unauthorized");
  }
});
test("loopback Host spoofed through a proxy is not local", () => {
  expect(isLoopback({ host: "127.0.0.1:3100", "x-real-ip": "1.2.3.4" })).toBe(false);
  expect(isLoopback({ host: "localhost", "x-forwarded-proto": "http" })).toBe(false);
  expect(isLoopback({ host: "localhost", forwarded: "for=1.2.3.4" })).toBe(false);
  expect(decide(input({ path: "/security", headers: { host: "127.0.0.1", "x-forwarded-for": "1.2.3.4" } }))).toBe("login_redirect");
});
test("only the sign-in minimum is public", () => {
  for (const path of ["/login", "/api/auth/login", "/api/auth/verify", "/api/auth/resend", "/_next/static/chunks/a.js"]) {
    expect(decide(input({ path })), path).toBe("allow");
  }
  expect(decide(input({ path: "/_next/image" }))).not.toBe("allow");
  expect(decide(input({ path: "/_next/foo" }))).not.toBe("allow");
});
test("proxy matcher runs on everything but static assets", async () => {
  const { config } = await import("../src/proxy");
  expect(config.matcher).toEqual(["/((?!_next/static/).*)"]);
  const re = new RegExp("^" + config.matcher[0] + "$");
  for (const p of ["/security", "/_next/image", "/favicon.icox"]) expect(re.test(p), p).toBe(true);
  expect(re.test("/_next/static/x.js")).toBe(false);
});
test("public share links: only GET/HEAD of /share/<32-char token>", () => {
  const tok = "A".repeat(16) + "b_-".repeat(5) + "c";
  expect(tok).toHaveLength(32);
  expect(decide(input({ path: `/share/${tok}` }))).toBe("allow");
  expect(decide(input({ path: `/share/${tok}`, method: "HEAD" }))).toBe("allow");
  expect(decide(input({ path: `/share/${tok}`, method: "POST" }))).toBe("login_redirect");
  for (const path of ["/share", "/share/", "/share/short", `/share/${tok}x`, `/share/${tok}/x`, "/share/../login%2f..", "/api/files/1/share"]) {
    expect(decide(input({ path })), path).not.toBe("allow");
  }
});
test("public share comments: exact routes only", () => {
  const tok = "A".repeat(16) + "b_-".repeat(5) + "c";
  for (const [method, path] of [["GET", `/share/${tok}/comments`], ["HEAD", `/share/${tok}/comments`], ["GET", `/share/${tok}/comments.js`], ["POST", `/share/${tok}/comments`], ["POST", `/share/${tok}/comments/12`]]) {
    expect(decide(input({ path, method })), `${method} ${path}`).toBe("allow");
  }
  for (const [method, path] of [["POST", `/share/${tok}`], ["POST", `/share/${tok}/comments.js`], ["POST", `/share/${tok}/comments/x`], ["POST", `/share/${tok}/comments/1/2`], ["PATCH", `/share/${tok}/comments/1`], ["DELETE", `/share/${tok}/comments/1`], ["GET", `/share/${tok}/comments/1`], ["POST", "/share/short/comments"], ["POST", `/share/${tok}x/comments`], ["GET", `/share/${tok}/commentsx`]]) {
    expect(decide(input({ path, method })), `${method} ${path}`).not.toBe("allow");
  }
});
test("toHeaderMap lowercases real Headers", () => {
  expect(toHeaderMap(new Headers({ Host: "a.example", "X-Forwarded-For": "1.2.3.4" }))).toEqual({ host: "a.example", "x-forwarded-for": "1.2.3.4" });
});
test("job-engine inbox is open to POST only; its other routes stay gated", () => {
  expect(decide(input({ path: "/api/job-engine/inbox", method: "POST", headers: viaNginx }))).toBe("allow");
  for (const [path, method] of [["/api/job-engine/inbox", "GET"], ["/api/job-engine/inbox/", "POST"], ["/api/job-engine/applications", "GET"], ["/api/job-engine/applications/x", "POST"]])
    expect(decide(input({ path, method, headers: viaNginx })), `${method} ${path}`).toBe("unauthorized");
  expect(decide(input({ path: "/job-engine", headers: viaNginx }))).toBe("login_redirect");
});
