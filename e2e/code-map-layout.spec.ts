import { test, expect, type Page } from "@playwright/test";

// Read-only: opens Analytics/Settings -> Code Map (Map view). Never presses Send or triggers an agent.

async function openMap(page: Page) {
  await page.goto("/analytics#codemap");
  await expect(page.getByTestId("codemap-panel")).toBeVisible({ timeout: 15_000 });
  const svg = page.getByTestId("code-map");
  await expect(svg).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => svg.locator('[data-testid^="code-map-node-"]').count(), { timeout: 20_000 }).toBeGreaterThan(50);
  await expect(svg).toHaveAttribute("data-settled", "true", { timeout: 30_000 });
  return svg;
}

// Independent of the component's own counter: recompute overlaps from the rendered circles.
async function domOverlaps(page: Page) {
  return page.evaluate(() => {
    const cs = [...document.querySelectorAll('[data-testid^="code-map-node-"]')].map((c) => ({
      x: +c.getAttribute("cx")!, y: +c.getAttribute("cy")!, r: +c.getAttribute("r")!,
    }));
    let bad = 0, maxR = 0, minDist = Infinity;
    for (let i = 0; i < cs.length; i++) {
      maxR = Math.max(maxR, cs[i].r);
      for (let j = i + 1; j < cs.length; j++) {
        const d = Math.hypot(cs[i].x - cs[j].x, cs[i].y - cs[j].y);
        minDist = Math.min(minDist, d - cs[i].r - cs[j].r);
        if (d < cs[i].r + cs[j].r) bad++;
      }
    }
    return { n: cs.length, bad, maxR, minGap: minDist };
  });
}

test("code map: no two file dots overlap after layout settles, radius capped", async ({ page }) => {
  const svg = await openMap(page);
  await expect(svg).toHaveAttribute("data-overlaps", "0");
  const r = await domOverlaps(page);
  expect(r.n).toBeGreaterThan(50);
  expect(r.bad).toBe(0);
  expect(r.maxR).toBeLessThanOrEqual(7);
});

test("code map: labels stay hidden when zoomed out, appear (capped) when zoomed in", async ({ page }) => {
  const svg = await openMap(page);
  await expect(svg.locator("text")).toHaveCount(0);
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 14; i++) await page.mouse.wheel(0, -300);
  await expect.poll(() => svg.locator("text").count()).toBeGreaterThan(0);
  expect(await svg.locator("text").count()).toBeLessThanOrEqual(61);
});

test("code map: filter chip, search, refresh, Map/Graph toggle still work", async ({ page }) => {
  const svg = await openMap(page);
  const nodes = svg.locator('[data-testid^="code-map-node-"]');
  const before = await nodes.count();
  await page.getByTestId("code-map-legend-api").click();
  await expect.poll(() => nodes.count()).toBeLessThan(before);
  await page.getByTestId("code-map-legend-api").click();
  await expect.poll(() => nodes.count()).toBe(before);
  await page.getByTestId("code-map-search").fill("db");
  await expect(svg.locator('[data-highlight="true"]').first()).toBeAttached();
  await page.getByTestId("code-map-search").fill("");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(svg).toHaveAttribute("data-settled", "true", { timeout: 30_000 });
  await expect(svg).toHaveAttribute("data-overlaps", "0");
  await page.getByTestId("code-view-graph").click();
  await expect(page.getByTestId("code-graph-root")).toBeVisible();
  await page.getByTestId("code-view-map").click();
  await expect(page.getByTestId("code-map")).toBeVisible();
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("code map on a phone: fits the screen, buttons zoom, two-finger pinch zooms, no overlaps", async ({ page }) => {
    const svg = await openMap(page);
    const box = (await svg.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(392);
    expect((await domOverlaps(page)).bad).toBe(0);

    const group = page.getByTestId("code-map-group");
    const t0 = await group.getAttribute("transform");
    await page.getByTestId("code-map-zoom-in").click();
    await expect.poll(() => group.getAttribute("transform")).not.toBe(t0);
    await page.getByTestId("code-map-fit").click();

    // synthetic two-pointer pinch (spread fingers apart) on the svg
    const t1 = await group.getAttribute("transform");
    await svg.evaluate((el, b) => {
      const mk = (type: string, id: number, x: number, y: number) =>
        el.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: "touch", isPrimary: id === 1 }));
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      mk("pointerdown", 1, cx - 20, cy);
      mk("pointerdown", 2, cx + 20, cy);
      for (let i = 1; i <= 6; i++) { mk("pointermove", 1, cx - 20 - i * 15, cy); mk("pointermove", 2, cx + 20 + i * 15, cy); }
      mk("pointerup", 1, cx - 110, cy);
      mk("pointerup", 2, cx + 110, cy);
    }, box);
    await expect.poll(() => group.getAttribute("transform")).not.toBe(t1);
    const scale = Number(/scale\(([\d.]+)\)/.exec((await group.getAttribute("transform")) || "")?.[1]);
    expect(scale).toBeGreaterThan(Number(/scale\(([\d.]+)\)/.exec(t1 || "")?.[1]));
  });
});
