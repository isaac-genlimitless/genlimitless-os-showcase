import { test, expect } from "@playwright/test";

// Read-only: Activity lives inside the Team tab. Never presses Send or starts an agent.

test("/team?view=activity opens the Activity view", async ({ page }) => {
  await page.goto("/team?view=activity");
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Tokens, last 24h")).toBeVisible();
  await expect(page.getByTestId("run-list")).toBeVisible();
  await expect(page.getByTestId("team-view-activity")).toHaveAttribute("aria-pressed", "true");
});

test("Team | Activity toggle switches views", async ({ page }) => {
  await page.goto("/team");
  await expect(page.getByTestId("team-view-tabs")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("team-view-activity").click();
  await expect(page.getByTestId("run-list")).toBeVisible();
  expect(page.url()).toContain("view=activity");
  await page.getByTestId("team-view-team").click();
  await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
});

test("standalone /activity still renders", async ({ page }) => {
  await page.goto("/activity");
  await expect(page.getByText("Tokens, last 24h")).toBeVisible({ timeout: 15_000 });
});
