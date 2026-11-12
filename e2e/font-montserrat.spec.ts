import { test, expect } from "@playwright/test";

test("OS UI uses Montserrat", async ({ page }) => {
  await page.goto("/files");

  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(bodyFont).toContain("Montserrat");

  const button = page.locator("button").first();
  if (await button.count()) {
    const f = await button.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(f).toContain("Montserrat");
  }

  const field = page.locator("input, textarea").first();
  if (await field.count()) {
    const f = await field.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(f).toContain("Montserrat");
  }

  const ws = page.getByText("Workspace", { exact: false }).first();
  if (await ws.count()) {
    const f = await ws.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(f).toContain("Montserrat");
  }

  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("link")).map((l) => l.getAttribute("href") || ""),
  );
  // Self-hosted via next/font since 2026-11-05: pages no longer wait on Google before drawing.
  expect(links.some((h) => h.includes("fonts.googleapis.com"))).toBe(false);
});
