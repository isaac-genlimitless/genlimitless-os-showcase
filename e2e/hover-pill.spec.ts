import { test, expect } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

const snap = (el: Element) => {
  const s = getComputedStyle(el);
  return { color: s.color, bg: s.backgroundColor, deco: s.textDecorationLine, radius: s.borderRadius };
};

test("sidebar nav hover: grey background, no recolour/underline", async ({ page }) => {
  await page.goto("/");
  const links = page.locator("aside[data-app-nav] nav a");
  const count = await links.count();
  let link = links.first();
  for (let i = 0; i < count; i++) {
    const cls = (await links.nth(i).getAttribute("class")) || "";
    if (!cls.includes("border-gold")) { link = links.nth(i); break; }
  }
  const before = await link.evaluate(snap);
  await link.hover();
  await page.waitForTimeout(300);
  const after = await link.evaluate(snap);
  expect(after.color).toBe(before.color);
  expect(after.bg).not.toBe(before.bg);
  expect(after.deco).toBe("none");
});

test("Files breadcrumb hover: pill, no recolour/underline", async ({ page }) => {
  await page.goto("/files");
  const link = page.locator("a.hover-pill", { hasText: /^Files$/ }).first();
  await expect(link).toBeVisible();
  const before = await link.evaluate(snap);
  await link.hover();
  await page.waitForTimeout(300);
  const after = await link.evaluate(snap);
  expect(after.color).toBe(before.color);
  expect(after.bg).not.toBe(before.bg);
  expect(after.deco).toBe("none");
  expect(after.radius).toBe("8px");

  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(bodyFont).toContain("Montserrat");
});
