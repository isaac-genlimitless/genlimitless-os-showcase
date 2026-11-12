import { test, expect } from "@playwright/test";

test("Settings Code Map and Cleanup candidates tabs open by click", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.getByText("Connected email accounts", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "File Map" })).toHaveCount(0);

  await page.getByRole("button", { name: "Code Map", exact: true }).click();
  await expect(page).toHaveURL(/#codemap$/);
  await expect(page.getByTestId("codemap-panel")).toBeVisible();
  await expect(page.getByTestId("codemap-panel").locator("svg").first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Cleanup candidates" }).click();
  await expect(page).toHaveURL(/#cleanup$/);
  await expect(page.getByRole("link", { name: "Open in Files" })).toBeVisible();

  await page.getByRole("button", { name: /^Fixes \(\d+\)$/ }).click();
  await expect(page).toHaveURL(/#fixes$/);
  await page.getByRole("button", { name: "Overview" }).click();
  await expect(page.getByText("Connected email accounts", { exact: true })).toBeVisible();
});

test("Settings tabs open from #codemap and #cleanup hashes", async ({ page }) => {
  await page.goto("/analytics#codemap");
  await expect(page.getByTestId("codemap-panel")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("codemap-panel").locator("svg").first()).toBeVisible({ timeout: 15_000 });

  await page.goto("/analytics#cleanup");
  await expect(page.getByRole("link", { name: "Open in Files" })).toBeVisible({ timeout: 15_000 });
});
