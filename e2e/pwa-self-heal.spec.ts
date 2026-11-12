import { test, expect } from "@playwright/test";

test("build-id endpoint returns the live build, uncached", async ({ request }) => {
  const res = await request.get("/api/build-id");
  expect(res.status()).toBe(200);
  expect((await res.text()).trim().length).toBeGreaterThan(0);
  expect(res.headers()["cache-control"]).toContain("no-store");
});

test("html carries the build id", async ({ page, request }) => {
  const id = (await (await request.get("/api/build-id")).text()).trim();
  await page.goto("/login");
  await expect(page.locator("html[data-build]")).toHaveAttribute("data-build", id);
});

test("a chunk failure reloads once and heals", async ({ page, request }) => {
  const id = (await (await request.get("/api/build-id")).text()).trim();
  await page.route("**/_next/static/chunks/**", (r) => r.abort());
  page.once("framenavigated", () => { void page.unroute("**/_next/static/chunks/**"); });
  await page.goto("/login");
  await page.waitForEvent("framenavigated");
  await expect(page.getByText("SIGN IN").first()).toBeVisible({ timeout: 15000 });
  const v = await page.evaluate((k) => sessionStorage.getItem(k), `glos-healed:${id}`);
  expect(v).toBe("1");
});

test("no reload loop when chunks keep failing", async ({ page }) => {
  await page.route("**/_next/static/chunks/**", (r) => r.abort());
  let navs = 0;
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs++; });
  await page.goto("/login");
  await page.waitForTimeout(3000);
  expect(navs).toBeLessThanOrEqual(2);
});
