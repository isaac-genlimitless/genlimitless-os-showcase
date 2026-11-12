import { test, expect } from "./isolated-test";

// Read-only: never clicks a button, never presses Send, never triggers an agent.
for (const size of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
  test(`communications jobs tab has no sideways scroll at ${size.width}px`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/job-engine?view=jobs");
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      const main = document.querySelector("main");
      return {
        doc: doc.scrollWidth - doc.clientWidth,
        main: main ? main.scrollWidth - main.clientWidth : 0,
      };
    });
    expect(overflow.doc).toBeLessThanOrEqual(0);
    expect(overflow.main).toBeLessThanOrEqual(0);
  });
}
