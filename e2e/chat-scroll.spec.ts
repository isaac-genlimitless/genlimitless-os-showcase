import { test, expect } from "@playwright/test";

// These tests never press Send — they must not trigger the agent or message anyone.

test("chat opens already at the latest message with no scroll animation", async ({ page }) => {
  await page.goto("/");
  const box = page.getByTestId("chat-messages").first();
  await expect(box).toBeVisible();

  const result = await box.evaluate(async (el) => {
    const gap = () => el.scrollHeight - el.scrollTop - el.clientHeight;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    await frame();
    const first = gap();
    const top = el.scrollTop;
    const tops: number[] = [];
    for (let i = 0; i < 5; i++) { await frame(); tops.push(el.scrollTop); }
    return { first, top, tops };
  });

  expect(result.first).toBeLessThan(5);
  for (const t of result.tops) expect(Math.abs(t - result.top)).toBeLessThan(2);
});
