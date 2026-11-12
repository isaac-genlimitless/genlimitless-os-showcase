import { test, expect } from "@playwright/test";

// Never presses Send or triggers an agent. Mail read is read-only.
test("linkedin API shape and validation", async ({ request }) => {
  const res = await request.get("/api/analytics/linkedin");
  expect(res.status()).toBe(200);
  const j = await res.json();
  expect(j.goal).toBe(20);
  expect(j.perDay).toHaveLength(14);
  expect(j.perWeek).toHaveLength(8);
  expect(Array.isArray(j.recent)).toBe(true);

  const ok = await request.post("/api/analytics/linkedin", { data: { day: "2026-01-05", count: 7 } });
  expect(ok.status()).toBe(200);
  const j2 = await ok.json();
  expect(j2.perDay).toHaveLength(14);
  expect(j2.perWeek).toHaveLength(8);

  expect((await request.post("/api/analytics/linkedin", { data: { count: -1 } })).status()).toBe(400);
  expect((await request.post("/api/analytics/linkedin", { data: { count: "x" } })).status()).toBe(400);
  expect((await request.post("/api/analytics/linkedin", { data: { day: "2999-01-01", count: 1 } })).status()).toBe(400);
});

test("linkedin tab renders and logs requests", async ({ page }) => {
  await page.goto("/communications?tab=linkedin");
  const panel = page.getByTestId("linkedin-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Daily requests vs goal of 20");
  await expect(panel).toContainText("Recent activity");
  await page.getByTestId("linkedin-requests-input").fill("5");
  await page.getByTestId("linkedin-requests-save").click();
  await expect(panel.getByText("5 / 20").first()).toBeVisible();
});
