import { test, expect } from "@playwright/test";

test("Code Map Graph view: edges, search/select, wheel zoom, drag pan, back to Map", async ({ page }) => {
  await page.goto("/analytics#codemap");
  await expect(page.getByTestId("codemap-panel")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("code-view-graph").click();

  const root = page.getByTestId("code-graph-root");
  await expect(root).toBeVisible();
  await expect.poll(async () => Number(await root.getAttribute("data-nodes")), { timeout: 20_000 }).toBeGreaterThan(50);
  expect(Number(await root.getAttribute("data-edges"))).toBeGreaterThan(50); // links actually exist

  const canvas = page.getByTestId("code-graph-canvas");
  await expect(canvas).toBeVisible();

  await page.getByTestId("code-graph-search").fill("db");
  await page.getByTestId("code-graph-search").press("Enter");
  await expect(page.getByTestId("code-graph-detail")).toBeVisible();
  await expect(page.getByTestId("code-graph-detail-path")).toHaveText(/^src\//);

  const box = (await canvas.boundingBox())!;
  const v0 = await canvas.getAttribute("data-view");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(() => canvas.getAttribute("data-view")).not.toBe(v0);

  const v1 = await canvas.getAttribute("data-view");
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + 50, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => canvas.getAttribute("data-view")).not.toBe(v1);

  await page.getByTestId("code-view-map").click();
  await expect(page.getByTestId("code-map")).toBeVisible({ timeout: 15_000 });
});
