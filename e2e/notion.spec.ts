import { test, expect } from "@playwright/test";

// Read-only: Notion connection status is reported and shown on Analytics. Never writes to Notion.

test("Notion status is reported and shown on Analytics", async ({ page, request }) => {
  const status = await (await request.get("/api/notion")).json();
  expect(typeof status.connected).toBe("boolean");
  await page.goto("/analytics");
  const badge = page.getByTestId("notion-status");
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await expect(badge).toHaveText(status.connected ? /Notion connected/ : /Notion: needs setup/);
});
