import { test, expect } from "@playwright/test";

// Read-only: never presses Send or triggers an agent.
test("jobs view deep link shows the Jobs panel", async ({ page }) => {
  await page.goto("/job-engine?view=jobs");
  await expect(page.getByTestId("je-view-jobs")).toHaveClass(/bg-gold/);
  await expect(page.getByTestId("jobs-panel")).toBeVisible();
});

test("linkedin view deep link shows the LinkedIn panel", async ({ page }) => {
  await page.goto("/job-engine?view=linkedin");
  await expect(page.getByTestId("je-view-linkedin")).toHaveClass(/bg-gold/);
  await expect(page.getByTestId("linkedin-panel")).toBeVisible();
});

test("Job Engine view buttons switch between Jobs and LinkedIn", async ({ page }) => {
  await page.goto("/job-engine?view=jobs");
  await page.getByTestId("je-view-linkedin").click();
  await expect(page.getByTestId("je-view-linkedin")).toHaveClass(/bg-gold/);
  await page.getByTestId("je-view-jobs").click();
  await expect(page.getByTestId("je-view-jobs")).toHaveClass(/bg-gold/);
});

test("Messages tab still renders the inbox", async ({ page }) => {
  await page.goto("/communications?tab=inbox");
  await expect(page.getByTestId("inbox-tab")).toHaveClass(/bg-gold/);
  await expect(page.getByTestId("jobs-panel")).toHaveCount(0);
});
