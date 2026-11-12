import { test, expect } from "@playwright/test";

// Chat home layout checks. Never presses Send or triggers an agent.

test("phone: message list gets most of the screen, composer on-screen, description hidden", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const list = page.getByTestId("chat-messages");
  await expect(list).toBeVisible({ timeout: 15_000 });

  const innerHeight = await page.evaluate(() => window.innerHeight);
  const listBox = await list.boundingBox();
  expect(listBox!.height).toBeGreaterThanOrEqual(innerHeight * 0.45);

  const ta = page.locator("textarea").first();
  await expect(ta).toBeVisible();
  const taBox = (await ta.boundingBox())!;
  expect(taBox.y + taBox.height).toBeLessThanOrEqual(innerHeight);
  // Fixed mobile top bar is 56px tall (h-14); textarea must sit below it.
  const bar = await page.locator("header.fixed").first().boundingBox();
  expect(taBox.y).toBeGreaterThanOrEqual(bar!.y + bar!.height);

  await expect(page.getByTestId("chat-header-description")).toBeHidden();
});

test("desktop: header description still visible", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("chat-header-description")).toBeVisible({ timeout: 15_000 });
});
