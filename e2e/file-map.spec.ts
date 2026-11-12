import { test, expect } from "./isolated-test";

// Requires the File Map tab in Settings (tab proposal) and /api/files/graph.
// Never presses Send or triggers an agent.
test("file map renders nodes and zooms with the wheel", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("tab", { name: /file map/i }).or(page.getByText(/^File Map$/)).first().click();

  const svg = page.getByTestId("file-map");
  await expect(svg).toBeVisible();
  const nodes = page.locator('[data-testid^="file-map-node-"]');
  await expect.poll(() => nodes.count()).toBeGreaterThan(0);

  const vp = page.getByTestId("file-map-viewport");
  const before = await vp.getAttribute("transform");
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await expect.poll(() => vp.getAttribute("transform")).not.toBe(before);
});
