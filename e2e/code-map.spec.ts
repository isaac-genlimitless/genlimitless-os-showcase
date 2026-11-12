import { test, expect } from "@playwright/test";

// Read-only: opens Settings -> Code Map. Never presses Send or triggers an agent.
// Requires tab wiring (Code Map 3/3).

test("code map renders nodes, searches, shows detail, and zooms", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("tab", { name: /code map/i }).or(page.getByText("Code Map", { exact: true })).first().click();

  const svg = page.getByTestId("code-map");
  await expect(svg).toBeVisible({ timeout: 20_000 });
  const nodes = svg.locator('[data-testid^="code-map-node-"]');
  await expect.poll(() => nodes.count(), { timeout: 20_000 }).toBeGreaterThan(50);

  await page.getByTestId("code-map-search").fill("db");
  await expect(svg.locator('[data-highlight="true"]').first()).toBeAttached();
  await page.getByTestId("code-map-search").fill("");

  await nodes.first().dispatchEvent("pointerdown", { button: 0, clientX: 0, clientY: 0 });
  await nodes.first().dispatchEvent("pointerup");
  await expect(page.getByTestId("code-map-detail")).toBeVisible();
  await expect(page.getByTestId("code-map-detail-path")).toHaveText(/^src\//);

  const group = page.getByTestId("code-map-group");
  const before = await group.getAttribute("transform");
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await expect.poll(() => group.getAttribute("transform")).not.toBe(before);
});
