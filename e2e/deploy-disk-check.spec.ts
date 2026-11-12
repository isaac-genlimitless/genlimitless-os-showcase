import { test, expect } from "@playwright/test";

// Never presses Deploy or Send, never triggers an agent.
test("GET /api/deploy reports free disk", async ({ request }) => {
  const res = await request.get("/api/deploy");
  const body = await res.json();
  test.skip(!body.enabled, "deploys are not enabled on this machine");
  expect(typeof body.disk.freeBytes).toBe("number");
});

test("deploy bar shows the failed-backup cause", async ({ page }) => {
  await page.route("**/api/deploy", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      json: {
        enabled: true,
        live: "abc123",
        latest: "def456",
        behind: true,
        disk: { freeBytes: 300_000_000, totalBytes: 10_000_000_000 },
        status: {
          state: "failed",
          message: "Database backup failed: database or disk is full (SQLITE_FULL). Free disk: 0.3 GB.",
          sha: "def456",
          at: new Date().toISOString(),
        },
      },
    });
  });
  await page.goto("/settings");
  await expect(page.getByText(/database or disk is full/).first()).toBeVisible();
});
