import { test, expect } from "@playwright/test";

// Read-only: never clicks Connect Gmail, Reply, or Send, and never calls Google.
// With no GOOGLE_CLIENT_ID / GMAIL_USER configured in the test env, zero accounts are
// connected, so these exercise the setup/empty states rather than real Gmail data.

test("GET /api/email returns valid JSON with zero accounts connected", async ({ request }) => {
  const res = await request.get("/api/email");
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  expect(Array.isArray(data.accounts)).toBe(true);
  expect(Array.isArray(data.messages)).toBe(true);
});

test("Email tab renders either the setup state or the account list", async ({ page }) => {
  // In CI no accounts are configured (setup state); on Owner's Mac his real accounts are.
  await page.goto("/communications");
  await page.getByRole("button", { name: "Email", exact: true }).click();
  const accounts = await (await page.request.get("/api/email")).json();
  if (accounts.accounts.length === 0) {
    await expect(page.getByTestId("email-empty-state")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("No email accounts connected yet")).toBeVisible();
  } else {
    await expect(page.getByTestId("email-empty-state")).toHaveCount(0);
    await expect(page.getByText(accounts.accounts[0].label).first()).toBeVisible({ timeout: 15_000 });
  }
});

test("Connected accounts panel renders on the Analytics page", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.getByTestId("connected-accounts")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Connected email accounts")).toBeVisible();
});
