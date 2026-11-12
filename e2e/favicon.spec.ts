import { test, expect } from "@playwright/test";

// This test only inspects the page head and fetches static icon assets —
// it never presses Send or triggers the agent.

test("page head has an icon link that returns an image", async ({ page, request }) => {
  await page.goto("/");

  const iconHref = await page.locator('link[rel="icon"]').first().getAttribute("href");
  expect(iconHref).toBeTruthy();

  const iconUrl = new URL(iconHref!, page.url()).toString();
  const response = await request.get(iconUrl);
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["content-type"]).toMatch(/^image\//);
});

test("page head has an apple touch icon link that returns an image", async ({ page, request }) => {
  await page.goto("/");

  const appleIconHref = await page
    .locator('link[rel="apple-touch-icon"]')
    .first()
    .getAttribute("href");
  expect(appleIconHref).toBeTruthy();

  const appleIconUrl = new URL(appleIconHref!, page.url()).toString();
  const response = await request.get(appleIconUrl);
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["content-type"]).toMatch(/^image\//);
});
