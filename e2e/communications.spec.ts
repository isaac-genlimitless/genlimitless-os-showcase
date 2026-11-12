import { test, expect } from "@playwright/test";

// Read-only: opens threads and searches, never sends.

test("Apple Messages is connected and conversations load", async ({ page }) => {
  await page.goto("/communications");
  await expect(page.getByText("Apple Messages isn't connected yet")).toHaveCount(0);
  const firstThread = page.locator("div.md\\:w-80 > button").first();
  await expect(firstThread).toBeVisible({ timeout: 15_000 });
  await firstThread.click();
  await expect(page.getByPlaceholder("iMessage")).toBeVisible();
  await expect(page.locator('[id^="msg-"]').first()).toBeVisible({ timeout: 10_000 });
});

test("desktop auto-opens the most recent thread", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/communications");
  await expect(page.getByPlaceholder("iMessage")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[id^="msg-"]').first()).toBeVisible({ timeout: 10_000 });
});

test("mobile keeps the list view with no thread open", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/communications");
  await expect(page.locator("div.md\\:w-80 > button").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByPlaceholder("iMessage")).toHaveCount(0);
});

test("search finds contacts and messages", async ({ page }) => {
  await page.goto("/communications");
  await page.getByPlaceholder("Search messages and contacts…").fill("Owner");
  await expect(page.getByRole("heading", { name: /Contacts \([1-9]/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: /Messages \([1-9]/ })).toBeVisible();
});

test("clicking a contact opens their conversation", async ({ page }) => {
  await page.goto("/communications");
  await page.getByPlaceholder("Search messages and contacts…").fill("Owner");
  await page.getByRole("heading", { name: /Contacts \(/ }).locator("..").locator("button").first().click();
  await expect(page.getByPlaceholder("iMessage")).toBeVisible({ timeout: 10_000 });
});

test("Campaign and Outreach tabs are gone; stale links land on Email", async ({ page }) => {
  await page.goto("/communications");
  await expect(page.getByRole("button", { name: "Outreach", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Campaign", exact: true })).toHaveCount(0);
  await page.goto("/communications?tab=campaign");
  await expect(page.getByTestId("email-tab")).toBeVisible();
});
