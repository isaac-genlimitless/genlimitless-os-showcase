import { test, expect } from "@playwright/test";

// Read-only: the new tabs render and the Chief of Staff sidebar opens on any screen.
// Never presses Send, never creates calendar events, never starts a recording.

test("sidebar has Files, Calendar and Meetings, and highlights the active one", async ({ page }) => {
  await page.goto("/calendar");
  const nav = page.locator("aside nav");
  for (const name of ["Chat", "Files", "Calendar", "Tasks", "Budgets", "Meetings", "Team", "Communications", "Settings"]) {
    await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await expect(nav.getByRole("link", { name: "Calendar", exact: true })).toHaveClass(/text-accent/);
});

test("Calendar shows either the week grid or how to connect", async ({ page }) => {
  await page.goto("/calendar");
  const status = await (await page.request.get("/api/calendar?start=2026-01-01T00:00:00Z&end=2026-01-02T00:00:00Z")).json();
  if (status.connected === false) {
    await expect(page.getByText("No calendar connected yet.")).toBeVisible({ timeout: 15_000 });
  } else {
    await expect(page.getByTestId("calendar-range")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Month" }).click();
    await expect(page.getByText("Sun", { exact: true })).toBeVisible();
  }
});

test("Meetings shows the recorder and which transcription engine is active", async ({ page }) => {
  await page.goto("/meetings");
  await expect(page.getByRole("button", { name: "Start recording" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Transcription:/)).toBeVisible();
});

test("the Chief of Staff sidebar opens on any page (button and ⌘J) and never on the full chat", async ({ page }) => {
  await page.goto("/files");
  await expect(page.getByRole("button", { name: /Ask Chief/ })).toBeVisible();
  await page.getByTestId("chat-dock-open").click();
  const dock = page.getByTestId("chat-dock");
  await expect(dock).toBeVisible();
  await expect(dock.getByPlaceholder("Ask about this page, or anything…")).toBeVisible({ timeout: 15_000 });
  await dock.getByRole("button", { name: "Close chat" }).click();
  await expect(dock).toHaveCount(0);

  await page.keyboard.press("Control+j");
  await expect(page.getByTestId("chat-dock")).toBeVisible();
  await page.keyboard.press("Control+j");

  await page.goto("/");
  await expect(page.getByTestId("chat-dock-open")).toHaveCount(0);
  await expect(page.getByTestId("chat-dock")).toHaveCount(0);
});
