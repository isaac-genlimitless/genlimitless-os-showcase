import { test, expect } from "./isolated-test";
import { dailyScheduleDue, markDailyScheduleRan, withScheduleReviewFences } from "../src/lib/schedule";
import { parseScheduleReview } from "../src/lib/schedule-review";
import { openTestDb } from "./db-handle";

// Seeds proposed schedule_items + a canned assistant chat reply carrying the
// ```schedule-review``` trigger block directly into the DB (there's no public POST endpoint for
// schedule_items by design — only the Chief of Staff's propose_schedule tool creates them, and
// that would mean running the live agent, which this suite never does).
//
// This test never presses Approve. Rejecting is safe (it never writes to a calendar) and proves
// the same per-item scoping; approving writes to a real calendar, and per playwright.config.ts
// the isolated server here still inherits whatever real Google/Apple credentials are in the
// environment (only its SQLite data directory is isolated) — same reasoning text-drafts.spec.ts
// gives for never clicking Approve/Send.

function dbHandle() {
  return openTestDb();
}

const stamp = Date.now();
// Far-future date: this Central calendar date can never collide with a real daily-schedule run.
const testDate = "2099-06-15";

let insertedChatId: number | bigint | null = null;
let itemIds: number[] = [];

test.afterEach(() => {
  if (!process.env.E2E_START_SERVER) return; // hooks still run for skipped tests; nothing was written
  const db = dbHandle();
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

test("schedule review popup: renders proposed blocks as an interactive card", async ({ page }) => {
  const db = dbHandle();
  try {
    const insert = db.prepare(`INSERT INTO schedule_items (date, title, start, end, description, reason) VALUES (?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 3; i++) {
      const info = insert.run(
        testDate,
        `E2E Focus Block ${i} ${stamp}`,
        `${testDate}T0${9 + i}:00:00-05:00`,
        `${testDate}T0${10 + i}:00:00-05:00`,
        "Deep work on the top priority.",
        "No dedicated time was on the calendar for this priority."
      );
      itemIds.push(Number(info.lastInsertRowid));
    }
    const chatInfo = db
      .prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant', ?)`)
      .run(`Proposed today's schedule.\n\n\`\`\`schedule-review ${testDate}\`\`\``);
    insertedChatId = chatInfo.lastInsertRowid;
  } finally {
    db.close();
  }

  await page.goto("/");

  const reviewButton = page.getByRole("button", { name: "Review schedule" }).last();
  await expect(reviewButton).toBeVisible();
  await reviewButton.click();

  const modal = page.getByTestId("schedule-review-modal");
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId("schedule-proposed-row")).toHaveCount(3);
  await expect(modal.getByTestId("count-proposed")).toHaveText("Proposed 3");
  await expect(modal.getByTestId("approve-schedule-item").first()).toBeVisible();
  await expect(modal.getByTestId("reject-schedule-item").first()).toBeVisible();
  await expect(modal.getByTestId("edit-schedule-item").first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
});

test("schedule review popup: Approve all count tracks rejections (never clicked)", async ({ page }) => {
  const db = dbHandle();
  try {
    const insert = db.prepare(`INSERT INTO schedule_items (date, title, start, end, description, reason) VALUES (?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 3; i++) {
      const info = insert.run(
        testDate,
        `E2E Bulk Block ${i} ${stamp}`,
        `${testDate}T0${9 + i}:00:00-05:00`,
        `${testDate}T0${10 + i}:00:00-05:00`,
        "Deep work.",
        "Test."
      );
      itemIds.push(Number(info.lastInsertRowid));
    }
    const chatInfo = db
      .prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant', ?)`)
      .run(`Proposed today's schedule.\n\n\`\`\`schedule-review ${testDate}\`\`\``);
    insertedChatId = chatInfo.lastInsertRowid;
  } finally {
    db.close();
  }

  await page.goto("/");
  await page.getByRole("button", { name: "Review schedule" }).last().click();
  const modal = page.getByTestId("schedule-review-modal");
  const all = modal.getByTestId("approve-all-schedule-items");
  await expect(all).toHaveText("Approve all (3)");
  await expect(all).toBeEnabled();

  await modal.getByTestId("reject-schedule-item").first().click();
  await expect(all).toHaveText("Approve all (2)");
  await expect(modal.getByTestId("count-rejected")).toHaveText("Rejected 1");

  await modal.getByTestId("reject-schedule-item").first().click();
  await expect(all).toHaveText("Approve all (1)");
  await modal.getByTestId("reject-schedule-item").first().click();
  await expect(all).toHaveText("Approve all (0)");
  await expect(all).toBeDisabled();
});

test("rejecting one proposed item only changes that item; nothing is ever written to a calendar for a proposed or rejected item", async ({ request }) => {
  const db = dbHandle();
  try {
    const insert = db.prepare(`INSERT INTO schedule_items (date, title, start, end, reason) VALUES (?, ?, ?, ?, ?)`);
    for (let i = 0; i < 3; i++) {
      const info = insert.run(testDate, `E2E Scoping Block ${i} ${stamp}`, `${testDate}T0${9 + i}:00:00-05:00`, `${testDate}T0${10 + i}:00:00-05:00`, "test");
      itemIds.push(Number(info.lastInsertRowid));
    }
  } finally {
    db.close();
  }
  const [idA, idB, idC] = itemIds;

  const res = await request.patch("/api/schedule-items", { data: { id: idB, action: "reject" } });
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).status).toBe("rejected");

  const listRes = await request.get(`/api/schedule-items?date=${testDate}`);
  const { proposed } = await listRes.json();
  const byId = new Map<number, any>(proposed.map((p: any) => [p.id, p]));

  expect(byId.get(idA)?.status).toBe("proposed"); // untouched
  expect(byId.get(idB)?.status).toBe("rejected"); // the one we acted on
  expect(byId.get(idC)?.status).toBe("proposed"); // untouched
  for (const id of [idA, idB, idC]) expect(byId.get(id)?.calendar_event_id).toBeNull();
});

test.describe("chat route attaches the review-card fence after propose_schedule", () => {
  test("appends one fence for the latest proposed date, leaves fenced replies alone, ignores older rows", () => {
    const db = dbHandle();
    let since: string;
    try {
      since = (db.prepare(`SELECT datetime('now', '-1 minute') AS t`).get() as { t: string }).t;
      const insert = db.prepare(
        `INSERT INTO schedule_items (date, title, start, end, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (let i = 0; i < 2; i++) {
        const info = insert.run(testDate, `E2E Fence Block ${i} ${stamp}`, `${testDate}T0${9 + i}:00:00-05:00`, `${testDate}T0${10 + i}:00:00-05:00`, "test", new Date().toISOString().slice(0, 19).replace("T", " "));
        itemIds.push(Number(info.lastInsertRowid));
      }
      // An older proposal for another date, inserted last (highest id) — must be ignored by `since`.
      const old = insert.run("2099-06-14", `E2E Old Block ${stamp}`, "2099-06-14T09:00:00-05:00", "2099-06-14T10:00:00-05:00", "test", "2000-01-01 00:00:00");
      itemIds.push(Number(old.lastInsertRowid));
    } finally {
      db.close();
    }

    // (a) no fence -> exactly one appended, and the card parser reads the date back
    const out = withScheduleReviewFences("I put the blocks on your schedule.", since);
    expect(out.match(/```schedule-review/g)).toHaveLength(1);
    expect(out).toContain("```schedule-review 2099-06-15```");
    expect(parseScheduleReview(out)?.date).toBe(testDate);

    // (b) already fenced -> unchanged
    const fenced = `Done.\n\n\`\`\`schedule-review ${testDate}\n\`\`\``;
    expect(withScheduleReviewFences(fenced, since)).toBe(fenced);

    // (c) rows older than `since` are ignored
    const future = "2999-01-01 00:00:00";
    expect(withScheduleReviewFences("Nothing proposed.", future)).toBe("Nothing proposed.");
  });
});

test.describe("catch-up:the daily schedule survives the server being asleep at 8:30am Central", () => {
  test("not due before 8:30, due once past 8:30 with no run logged, and never due twice for the same Central date", () => {
    const before830 = new Date(`${testDate}T11:00:00Z`); // ~6am Central
    const after830 = new Date(`${testDate}T17:00:00Z`); // ~noon Central — "server woke at 11am"
    const laterSameDay = new Date(`${testDate}T23:00:00Z`); // ~6pm Central, still the same date

    expect(dailyScheduleDue(before830)).toBe(false);
    expect(dailyScheduleDue(after830)).toBe(true);

    markDailyScheduleRan(after830);

    expect(dailyScheduleDue(after830)).toBe(false); // idempotent: the same check won't fire it twice
    expect(dailyScheduleDue(laterSameDay)).toBe(false); // nor would a later tick the same day
  });
});
