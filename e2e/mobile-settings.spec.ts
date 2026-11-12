import { test, expect } from "./isolated-test";

// Read-only: only navigates and measures. Never clicks a button or triggers an agent.
for (const size of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
  test.describe(`settings at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test("page does not scroll sideways", async ({ page }) => {
      await page.goto("/settings");
      await page.waitForLoadState("networkidle");
      const m = await page.evaluate(() => {
        const main = document.querySelector("main");
        return {
          docScroll: document.documentElement.scrollWidth,
          inner: window.innerWidth,
          mainScroll: main ? main.scrollWidth : 0,
          mainClient: main ? main.clientWidth : 0,
        };
      });
      expect(m.docScroll).toBeLessThanOrEqual(m.inner);
      expect(m.mainScroll).toBeLessThanOrEqual(m.mainClient);
    });
  });
}
