import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { decide, type PolicyInput } from "../src/lib/auth/policy";

// Read-only: the OS installs as a phone app (Add to Home Screen / Install app).
// The phone fetches the manifest and icons while installing, often without the session cookie,
// so they must stay reachable before login while everything else stays gated.

const ext = { host: "os.example.com", "x-forwarded-for": "203.0.113.9", accept: "text/html" };
const enforced = (path: string): PolicyInput => ({ path, method: "GET", headers: ext, enrolled: true, enforce: true, breakGlass: false, sessionValid: false });

test("manifest and app icons are public; look-alike paths stay gated", () => {
  for (const p of ["/manifest.webmanifest", "/app-icons/icon-192.png", "/app-icons/icon-512.png", "/app-icons/maskable-512.png", "/app-icons/apple-touch-icon.png"]) {
    expect(decide(enforced(p)), p).toBe("allow");
  }
  for (const p of ["/app-icons/", "/app-icons/../api/chat", "/app-icons/x.png/secret", "/app-iconsx/icon.png", "/api/app-icons/icon-192.png"]) {
    expect(decide(enforced(p)), p).not.toBe("allow");
  }
});

test("manifest describes a standalone app with installable icons", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  const m = await res.json();
  expect(m.display).toBe("standalone");
  expect(m.start_url).toBe("/today");
  const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toContain("192x192");
  expect(sizes).toContain("512x512");
  for (const icon of m.icons) {
    const r = await request.get(icon.src);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()["content-type"]).toContain("image/png");
  }
});

test("pages link the manifest and iPhone home-screen tags", async ({ page }) => {
  await page.goto("/today");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", /manifest\.webmanifest/);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /\/app-icons\/apple-touch-icon\.png/);
  await expect(page.locator('meta[name="mobile-web-app-capable"], meta[name="apple-mobile-web-app-capable"]').first()).toHaveAttribute("content", "yes");
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute("content", /#/);
  await expect(page.locator('link[rel="icon"][href^="/icon.png"]')).toHaveCount(1); // browser-tab icon kept
});

// On the server, nginx basic auth sits in front of the app. Without its own exception the phone gets
// nginx's 401 page for the icons and shows a letter "G" instead of the phoenix (2026-11-04).
test("nginx lets the manifest and app icons through basic auth, and nothing else", () => {
  const conf = fs.readFileSync(path.join(__dirname, "../bridge/nginx-os-genlimitless.conf"), "utf8");
  const m = conf.match(/location ~ "(\^\/\(manifest[^"]+)" \{([^}]*)\}/);
  expect(m, "app-icon location block in bridge/nginx-os-genlimitless.conf").toBeTruthy();
  expect(m![2]).toContain("auth_basic off;");
  const re = new RegExp(m![1]);
  for (const p of ["/manifest.webmanifest", "/app-icons/icon-192.png", "/app-icons/icon-512.png", "/app-icons/maskable-512.png", "/app-icons/apple-touch-icon.png"]) {
    expect(re.test(p), p).toBe(true);
    expect(decide(enforced(p)), `app policy agrees on ${p}`).toBe("allow");
  }
  for (const p of ["/app-icons/../api/chat", "/app-icons/x.png/y", "/today", "/api/chat", "/manifest.webmanifestx"]) expect(re.test(p), p).toBe(false);
});
