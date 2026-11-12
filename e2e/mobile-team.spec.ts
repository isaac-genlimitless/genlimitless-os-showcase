import { test, expect } from "./isolated-test";

// Read-only: never presses Send, never clicks Save, never triggers an agent.
for (const vp of [
  { width: 390, height: 844 },
  { width: 320, height: 640 },
]) {
  test(`team page has no sideways scroll at ${vp.width}x${vp.height}`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto("/team");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("h1").first()).toBeVisible();

    const noHScroll = await page.evaluate(() => {
      const d = document.documentElement;
      const m = document.querySelector("main");
      return (
        d.scrollWidth <= d.clientWidth && (!m || m.scrollWidth <= m.clientWidth)
      );
    });
    expect(noHScroll).toBe(true);
  });
}
