import { test, expect } from "@playwright/test";

// Read-only: opens Settings -> Code Map. Never presses Send or triggers an agent.

async function open(page: import("@playwright/test").Page) {
  await page.goto("/settings");
  await page.getByRole("tab", { name: /code map/i }).or(page.getByText("Code Map", { exact: true })).first().click();
  const svg = page.getByTestId("code-map");
  await expect(svg).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => svg.locator('[data-testid^="code-map-node-"]').count(), { timeout: 20_000 }).toBeGreaterThan(50);
  return svg;
}

async function hideAndRestore(page: import("@playwright/test").Page) {
  const svg = await open(page);
  await page.getByTestId("code-map-legend-ui-page").click();
  await expect(page.getByTestId("code-map-legend-ui-page")).toHaveCSS("opacity", "0.35");
  await expect(svg.locator('[data-hidden-links]:not([data-hidden-links="0"])').first()).toBeAttached();
  await expect(page.getByTestId("code-map-isolated")).toBeVisible();
  await page.getByTestId("code-map-show-all").click();
  await expect(page.getByTestId("code-map-legend-ui-page")).toHaveCSS("opacity", "1");
  await expect(svg.locator('[data-hidden-links]:not([data-hidden-links="0"])')).toHaveCount(0);
  return svg;
}

test("hidden-role links are cued and Show all resets the filter", async ({ page }) => {
  await hideAndRestore(page);
});

test("same at phone width, and background drag still pans", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const svg = await hideAndRestore(page);
  const group = page.getByTestId("code-map-group");
  const before = await group.getAttribute("transform");
  const box = (await svg.boundingBox())!;
  const x = box.x + 4, y = box.y + 4;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => group.getAttribute("transform")).not.toBe(before);
});
