import { test, expect } from "@playwright/test";

test("analytics loads stats", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.getByText("Connected email accounts", { exact: true })).toBeVisible({ timeout: 15_000 });
});

test("settings overview hides campaign stats", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByText("Connected email accounts", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  for (const label of [
    "Schools found",
    "Emails sent",
    "Cancelled messages",
    "Awaiting review",
    "Reply rate",
    "Pipeline by status",
    "Sent, last 7 days",
    "By channel",
  ]) {
    await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  }
});
