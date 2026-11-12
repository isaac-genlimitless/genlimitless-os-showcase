import { test, expect } from "@playwright/test";

// Read-only: the Activity page renders, and the Stop endpoint answers safely when nothing runs.
// Never starts an agent.

test("Activity page shows usage totals and the run list", async ({ page }) => {
  await page.goto("/activity");
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Tokens, last 24h")).toBeVisible();
  await expect(page.getByTestId("run-list")).toBeVisible();
  await expect(page.locator("aside nav").getByRole("link", { name: "Team", exact: true })).toBeVisible();
  await expect(page.locator("aside nav").getByRole("link", { name: "Activity", exact: true })).toHaveCount(0);
});

test("runs API lists runs and totals; Stop with nothing running is a no-op", async ({ request }) => {
  const d = await (await request.get("/api/runs")).json();
  expect(Array.isArray(d.runs)).toBeTruthy();
  expect(typeof d.today.total.cost_usd).toBe("number");
  const stop = await (await request.post("/api/runs", { data: { thread: "e2e-no-such-chat" } })).json();
  expect(stop.stopped).toBe(false);
  const live = await (await request.get("/api/runs?live=e2e-no-such-chat")).json();
  expect(live.run).toBeNull();
});
