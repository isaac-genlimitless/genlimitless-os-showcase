import { test, expect } from "@playwright/test";

test("analytics Fixes tab lists history and toggles row details", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.getByText("Connected email accounts", { exact: true })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /^Fixes \(\d+\)$/ }).click();
  await expect(page).toHaveURL(/#fixes$/);
  await expect(page.getByText("Connected email accounts", { exact: true })).toHaveCount(0);

  const rows = page.getByTestId("fix-row");
  if ((await rows.count()) === 0) {
    await expect(page.getByText("No fixes yet.")).toBeVisible();
    return;
  }

  const first = rows.first();
  await expect(first.getByTestId("fix-details")).toHaveCount(0);
  await first.getByRole("button").first().click();
  await expect(first.getByTestId("fix-details")).toBeVisible();
  await first.getByRole("button").first().click();
  await expect(first.getByTestId("fix-details")).toHaveCount(0);
});

test("Proposed fixes cards show their proposal number", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.getByText("Connected email accounts", { exact: true })).toBeVisible({ timeout: 15_000 });

  const cards = page.getByTestId("proposal-card");
  if ((await cards.count()) === 0) return; // nothing pending

  await expect(cards.first().getByTestId("proposal-number")).toHaveText(/^#\d+$/);
});
