import { test, expect } from "@playwright/test";

test("sidebar nav icons are ~22px and all the same gold", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const icons = page.locator("aside[data-app-nav] [data-testid='nav-icon']");
  await expect(icons).toHaveCount(14);
  const colors = new Set<string>();
  for (let i = 0; i < 14; i++) {
    const svg = icons.nth(i).locator("svg");
    const box = await svg.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(20);
    expect(box!.width).toBeLessThanOrEqual(24);
    colors.add(await icons.nth(i).evaluate((el) => getComputedStyle(el).color));
  }
  expect(colors.size).toBe(1);
  const logoColor = await page
    .locator("aside[data-app-nav] span.text-accent")
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  expect([...colors][0]).toBe(logoColor);
  for (const name of ["Chat", "Today", "Decisions", "Files", "The Creation", "Calendar", "Tasks", "Meetings", "Team", "Communications", "Settings"]) {
    await expect(page.locator("aside[data-app-nav]").getByRole("link", { name })).toBeVisible();
  }
});

test("sidebar logo fits inside the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const aside = page.locator("aside[data-app-nav]");
  const span = aside.locator("span.text-accent").first();
  const spanBox = await span.boundingBox();
  const asideBox = await aside.boundingBox();
  expect(spanBox!.x + spanBox!.width).toBeLessThanOrEqual(asideBox!.x + asideBox!.width);
  const fits = await span.evaluate((el) => {
    const c = el.parentElement!;
    return c.scrollWidth <= c.clientWidth;
  });
  expect(fits).toBe(true);
});

test("hovering an inactive nav link keeps text colour and adds a background", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const link = page.locator("aside[data-app-nav]").getByRole("link", { name: "Files" });
  const read = () => link.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, bg: s.backgroundColor };
  });
  const before = await read();
  await link.hover();
  await page.waitForTimeout(400);
  const after = await read();
  expect(after.color).toBe(before.color);
  expect(after.bg).not.toBe(before.bg);
});
