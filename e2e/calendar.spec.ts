import { test, expect } from "@playwright/test";

// Read-only: never clicks Connect Google Calendar, and never calls Google.
// With no GOOGLE_CLIENT_ID configured in the test env, configured is false, so this exercises
// the setup state rather than a real OAuth round trip.

test("GET /api/google/auth?status=1&service=calendar reflects GOOGLE_CLIENT_ID", async ({ request }) => {
  const res = await request.get("/api/google/auth?status=1&service=calendar");
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  expect(typeof data.connected).toBe("boolean");
  expect(data.configured).toBe(!!process.env.GOOGLE_CLIENT_ID);
});

test("Analytics shows the Calendar connect state", async ({ page }) => {
  await page.goto("/analytics");
  const status = await (await page.request.get("/api/google/auth?status=1&service=calendar")).json();
  if (status.connected) {
    await expect(page.getByText("Google Calendar connected")).toBeVisible({ timeout: 15_000 });
  } else if (status.configured) {
    await expect(page.getByRole("link", { name: "Connect Google Calendar" })).toBeVisible({ timeout: 15_000 });
  } else {
    await expect(page.getByText("Google Calendar: needs setup")).toBeVisible({ timeout: 15_000 });
  }
});
