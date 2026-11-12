import { test, expect } from "@playwright/test";

// Regression guards for "the chat lags while typing": long histories must be windowed, and a
// keystroke must not re-render (re-parse the markdown of) every message.

test("long chat history is windowed, with a button to reveal earlier messages", async ({ page, request }) => {
  const { messages } = await (await request.get("/api/chat")).json();
  test.skip(messages.length <= 60, "needs more than 60 messages of history");
  await page.goto("/");
  await expect(page.locator(".markdown-body").first()).toBeVisible();
  expect(await page.locator(".markdown-body").count()).toBeLessThanOrEqual(61);
  const button = page.getByTestId("show-earlier");
  await expect(button).toBeVisible();
  const before = await page.locator(".markdown-body").count();
  await button.click();
  expect(await page.locator(".markdown-body").count()).toBeGreaterThan(before);
});

test("a keystroke in the composer renders fast even with a long history", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".markdown-body").first()).toBeVisible();
  const bubbles = await page.locator(".markdown-body").count();
  test.skip(bubbles < 30, "needs a long history to be meaningful");
  // Before the fix every keystroke re-parsed every message: ~180-260ms with 170 messages.
  // After: ~33ms (two animation frames). 120ms leaves plenty of slack for slow machines.
  const times: number[] = await page.evaluate(async () => {
    const ta = document.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    const out: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      setter.call(ta, "x".repeat(i + 1));
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      out.push(performance.now() - t0);
    }
    setter.call(ta, "");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return out;
  });
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  expect(median, `median keystroke render was ${Math.round(median)}ms`).toBeLessThan(120);
  // never presses Send
});
