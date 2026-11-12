import { test, expect } from "./isolated-test";

// Read-only: never clicks Approve, Decline or Send, and never triggers an agent.
for (const vp of [
  { width: 390, height: 844 },
  { width: 320, height: 640 },
]) {
  test(`approval buttons are 44px tap targets at ${vp.width}x${vp.height}`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto("/team");
    await page.waitForLoadState("networkidle");

    const noHScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(noHScroll).toBe(true);

    const buttons = page.locator("[data-testid=needs-approval] button");
    const n = await buttons.count();
    for (let i = 0; i < n; i++) {
      const box = await buttons.nth(i).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
}
