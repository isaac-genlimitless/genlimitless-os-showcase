import { test, expect } from "@playwright/test";

test("files tree expand/collapse arrows are large enough to click", async ({ page }) => {
  await page.goto("/files");
  const btn = page
    .locator('[data-testid^="tree-item-"] button[aria-label="Expand"], [data-testid^="tree-item-"] button[aria-label="Collapse"]')
    .locator("visible=true")
    .first();
  if ((await btn.count()) === 0) {
    test.skip(true, "tree has no folders");
    return;
  }
  const fontSize = await btn.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(14);
  const box = await btn.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(18);
  expect(box!.height).toBeGreaterThanOrEqual(18);
});
