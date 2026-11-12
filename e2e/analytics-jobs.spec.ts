import { test, expect } from "@playwright/test";

// Read-only: presses no Send and triggers no agent.
test("GET /api/analytics/jobs returns parsed tracker data", async ({ request }) => {
  const res = await request.get("/api/analytics/jobs");
  expect(res.ok()).toBeTruthy();
  const j = await res.json();
  expect(typeof j.found).toBe("boolean");
  if (j.found) {
    expect(j.stats.applications).toBe(j.applications.length);
    expect(typeof j.stats.offers).toBe("number");
    expect(Array.isArray(j.upcoming)).toBe(true);
  }
});

test("Communications Job applications tab shows tiles and tables", async ({ page, request }) => {
  const j = await (await request.get("/api/analytics/jobs")).json();
  await page.goto("/job-engine?view=jobs");
  if (!j.found) {
    await expect(page.getByText("Job Application Tracker page not found in Files.")).toBeVisible({ timeout: 15_000 });
    return;
  }
  const panel = page.getByTestId("jobs-panel");
  await expect(panel.getByText("Applications", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText("Interviews", { exact: true }).first()).toBeVisible();
  await expect(panel.getByRole("columnheader", { name: "Company" }).first()).toBeVisible();
  if ((j.applications as { company: string }[]).some((a) => a.company.includes("Glean"))) {
    await expect(panel.getByRole("cell", { name: /Glean/ }).first()).toBeVisible();
  }
});

test("Old /analytics#jobs link redirects to Communications", async ({ page }) => {
  await page.goto("/analytics#jobs");
  await expect(page).toHaveURL(/\/job-engine\?view=jobs/, { timeout: 15_000 });
});
