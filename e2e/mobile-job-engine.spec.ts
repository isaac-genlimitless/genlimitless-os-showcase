import { test, expect } from "./isolated-test";

// /job-engine on phones: no sideways scroll, list buttons are at least 44px tall.
// Never presses a decision button or Send.

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];

for (const vp of VIEWPORTS) {
  test.describe(`job-engine ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test("fits the screen with 44px tap targets", async ({ page }) => {
      await page.goto("/job-engine");
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      const m = await page.evaluate(() => {
        const main = document.querySelector("main");
        return {
          docW: document.documentElement.scrollWidth,
          inner: window.innerWidth,
          mainScroll: main ? main.scrollWidth : 0,
          mainClient: main ? main.clientWidth : 0,
        };
      });
      expect(m.docW).toBeLessThanOrEqual(m.inner);
      expect(m.mainScroll).toBeLessThanOrEqual(m.mainClient);

      const rows = page.getByTestId("je-list").locator("button");
      const n = await rows.count();
      for (let i = 0; i < n; i++) {
        const box = await rows.nth(i).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
    });
  });
}
