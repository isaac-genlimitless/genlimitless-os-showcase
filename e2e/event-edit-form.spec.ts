import { test, expect } from "./isolated-test";
import { centralToIso, centralParts } from "../src/lib/time";
import { openTestDb } from "./db-handle";

// Never presses Approve/Send and runs no agent. Save only writes the schedule_items DB row.

const stamp = Date.now();
const testDate = "2099-06-15";
let insertedChatId: number | bigint | null = null;
let itemIds: number[] = [];

test.afterEach(() => {
  if (!process.env.E2E_START_SERVER) return;
  const db = openTestDb();
  try {
    if (itemIds.length) db.prepare(`DELETE FROM schedule_items WHERE id IN (${itemIds.map(() => "?").join(",")})`).run(...itemIds);
    if (insertedChatId !== null) db.prepare(`DELETE FROM chat_history WHERE id = ?`).run(insertedChatId);
    db.prepare(`DELETE FROM job_runs WHERE job='daily_schedule' AND run_key=?`).run(testDate);
  } finally {
    db.close();
    itemIds = [];
    insertedChatId = null;
  }
});

test("central time helpers build correct offsets", () => {
  expect(centralToIso("2099-06-15", 12, 45)).toBe("2099-06-15T12:45:00-05:00");
  expect(centralToIso("2099-01-15", 12, 45)).toBe("2099-01-15T12:45:00-06:00");
  const p = centralParts(new Date(centralToIso("2099-06-15", 13, 15)));
  expect(p).toEqual({ date: "2099-06-15", hour24: 13, minute: 15 });
});

test("schedule edit form uses friendly pickers and validates end > start", async ({ page }) => {
  const db = openTestDb();
  let id = 0;
  try {
    const info = db
      .prepare(`INSERT INTO schedule_items (date, title, start, end, description, reason) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(testDate, `E2E Edit Block ${stamp}`, `${testDate}T12:45:00-05:00`, `${testDate}T13:45:00-05:00`, "d", "r");
    id = Number(info.lastInsertRowid);
    itemIds.push(id);
    const chat = db
      .prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant', ?)`)
      .run(`Proposed today's schedule.\n\n\`\`\`schedule-review ${testDate}\`\`\``);
    insertedChatId = chat.lastInsertRowid;
  } finally {
    db.close();
  }

  await page.goto("/");
  await page.getByRole("button", { name: "Review schedule" }).last().click();
  const modal = page.getByTestId("schedule-review-modal");
  await modal.getByTestId("edit-schedule-item").first().click();

  const values = await modal.locator("input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  for (const v of values) expect(v).not.toMatch(/T\d\d:\d\d:\d\d/);

  await expect(modal.getByTestId("edit-start-hour")).toHaveValue("12");
  await expect(modal.getByTestId("edit-start-minute")).toHaveValue("45");
  await expect(modal.getByTestId("edit-start-ampm")).toHaveValue("PM");

  // End earlier than start → invalid.
  await modal.getByTestId("edit-end-hour").selectOption("11");
  await modal.getByTestId("edit-end-ampm").selectOption("AM");
  await expect(modal.getByTestId("schedule-edit-error")).toBeVisible();
  await expect(modal.getByTestId("save-schedule-item")).toBeDisabled();

  // Restore a valid end (2:45 PM), then move start to 1:15 PM; end keeps the 2h duration.
  await modal.getByTestId("edit-end-hour").selectOption("2");
  await modal.getByTestId("edit-end-ampm").selectOption("PM");
  await expect(modal.getByTestId("save-schedule-item")).toBeEnabled();
  await modal.getByTestId("edit-start-hour").selectOption("1");
  await modal.getByTestId("edit-start-minute").selectOption("15");
  await expect(modal.getByTestId("edit-end-hour")).toHaveValue("3");
  await expect(modal.getByTestId("edit-end-minute")).toHaveValue("15");

  await modal.getByTestId("save-schedule-item").click();
  await expect(modal.getByTestId("save-schedule-item")).toHaveCount(0);

  const db2 = openTestDb();
  try {
    const row = db2.prepare(`SELECT start, end FROM schedule_items WHERE id = ?`).get(id) as { start: string; end: string };
    expect(row.start.endsWith("-05:00")).toBe(true);
    expect(new Date(row.end).getTime()).toBeGreaterThan(new Date(row.start).getTime());
  } finally {
    db2.close();
  }
});
