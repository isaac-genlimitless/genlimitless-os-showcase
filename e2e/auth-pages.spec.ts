import { test, expect } from "@playwright/test";
test.skip(!process.env.E2E_START_SERVER, "assumes a not-enrolled/fresh DB — only runs under `npm run test:e2e:branch` (isolated server)");

// Never submits a correct password, never calls setup "send_code" or /api/auth/resend,
// never presses Send or triggers the agent. No iMessage is ever sent.

test("login page shows a password input and a Continue button", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
});

test("the sign-in page stands on its own (no OS sidebar or chat) and matches the OS", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByTestId("login-page")).toBeVisible();
  await expect(page.getByText("LIMITLESS")).toBeVisible();
  await expect(page.locator("aside nav")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask Chief" })).toHaveCount(0);
});

test("security setup page shows the choose a password step on a fresh DB", async ({ page }) => {
  await page.goto("/security/setup");
  await expect(page.getByText("Choose a password")).toBeVisible();
});

test("login before setup returns 409", async ({ request }) => {
  const res = await request.post("/api/auth/login", { data: { password: "wrong-password-123" } });
  expect(res.status()).toBe(409);
});

test("verify without a challenge cookie returns 401", async ({ request }) => {
  const res = await request.post("/api/auth/verify", { data: { code: "000000", kind: "imessage" } });
  expect(res.status()).toBe(401);
});

test("setup rejects a short password", async ({ request }) => {
  const res = await request.post("/api/auth/setup", { data: { action: "password", password: "short" } });
  expect(res.status()).toBe(400);
});

test("existing pages still load with no cookie", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.ok()).toBeTruthy();
});
