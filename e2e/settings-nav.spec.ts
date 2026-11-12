import { test, expect } from "@playwright/test";

test("sidebar shows Settings and links to /settings", async ({ page }) => {
  await page.goto("/");
  const link = page.locator("aside[data-app-nav] a", { hasText: "Settings" });
  await expect(link).toHaveAttribute("href", "/settings");
});

test("/analytics#fixes still loads with Settings heading", async ({ page }) => {
  await page.goto("/analytics#fixes");
  await expect(page.locator("h1", { hasText: "Settings" })).toBeVisible();
});

test("/settings renders the Settings page", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.locator("h1", { hasText: "Settings" })).toBeVisible();
});
