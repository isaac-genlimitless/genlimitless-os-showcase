import { test, expect } from "@playwright/test";

// Read-only page loads. Never presses Send, never triggers an agent.

test("sw.js is served and only handles page navigations", async ({ request }) => {
  const res = await request.get("/sw.js");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("javascript");
  const body = await res.text();
  expect(body).toContain('req.mode !== "navigate"');
  expect(body).toMatch(/SKIP = \/.*api.*\//);
});

test("offline page loads show a saved copy or Reconnecting, never the browser error", async ({ page, context }) => {
  await page.goto("/today");
  const scope = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope));
  expect(scope.endsWith("/")).toBe(true);
  await page.reload(); // now controlled by the service worker

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page).toHaveTitle(/GenLimitless AI OS/);
    expect(page.url()).toContain("/today");
    expect(await page.locator("body").innerText()).not.toContain("ERR_INTERNET_DISCONNECTED");

    await page.goto("/calendar");
    await expect(page).toHaveTitle(/GenLimitless AI OS/);
    expect(await page.locator("body").innerText()).not.toContain("ERR_INTERNET_DISCONNECTED");

    // /api is untouched: it fails offline instead of being served from cache.
    const failed = await page.evaluate(() => fetch("/api/build-id").then(() => false, () => true));
    expect(failed).toBe(true);
  } finally {
    await context.setOffline(false);
  }

  const status = await page.evaluate(() => fetch("/api/build-id").then((r) => r.status));
  expect(status).toBe(200);
});
