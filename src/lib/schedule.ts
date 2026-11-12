import db, { jobAlreadyRan, recordJobRun, ScheduleItemRow } from "./db";
import { centralDateKey, centralHourDow, centralMinuteOfDay } from "./time";
import { findExistingCalendarEvent, normalizeTitle } from "./dedupe";

// The Chief of Staff's proposed daily schedule: new focus blocks / holds only (never existing
// meetings, which stay on the calendar untouched — the review card fetches those live). Nothing
// here writes to any calendar until Owner approves a specific row; see the schedule-items API
// route and ScheduleReviewModal.tsx, with a modal card in chat.

export function listScheduleItems(date: string): ScheduleItemRow[] {
  return db.prepare(`SELECT * FROM schedule_items WHERE date=? ORDER BY start ASC`).all(date) as ScheduleItemRow[];
}

export function getScheduleItem(id: number): ScheduleItemRow | undefined {
  return db.prepare(`SELECT * FROM schedule_items WHERE id=?`).get(id) as ScheduleItemRow | undefined;
}

/** Draft the day's proposed blocks. Called by the Chief of Staff's propose_schedule tool — never
 *  touches a calendar. */
export function proposeSchedule(
  date: string,
  items: { title: string; start: string; end: string; description?: string; account?: string; reason: string }[]
): { date: string; item_ids: number[] } {
  const insert = db.prepare(
    `INSERT INTO schedule_items (date, title, start, end, description, account, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAll = db.transaction((rows: typeof items) =>
    rows.map((it) => {
      // Duplicate guard: reuse an existing non-rejected item with the same title near the same start.
      const existing = (
        db.prepare(`SELECT id, title, start FROM schedule_items WHERE date=? AND status NOT IN ('rejected','expired','superseded')`).all(date) as { id: number; title: string; start: string }[]
      ).find((r) => {
        if (normalizeTitle(r.title) !== normalizeTitle(it.title)) return false;
        const diff = Math.abs(Date.parse(r.start) - Date.parse(it.start));
        return !Number.isNaN(diff) && diff <= 60 * 60000;
      });
      if (existing) return existing.id;
      return Number(insert.run(date, it.title, it.start, it.end, it.description || null, it.account || null, it.reason).lastInsertRowid);
    })
  );
  return { date, item_ids: insertAll(items) };
}

/** Chat replies only open the schedule review card when they carry a ```schedule-review DATE```
 *  fence (see schedule-review.ts). The cron path writes that fence itself; when the Chief of Staff
 *  calls propose_schedule from interactive chat it doesn't, so the chat route calls this to attach
 *  the fence for the most recent date proposed since `sinceSqliteUtc` (a SQLite UTC datetime).
 *  parseScheduleReview reads only one fence per message, so only the latest date is appended. */
export function withScheduleReviewFences(reply: string, sinceSqliteUtc: string): string {
  const row = db
    .prepare(`SELECT date FROM schedule_items WHERE status='proposed' AND created_at >= ? ORDER BY id DESC LIMIT 1`)
    .get(sinceSqliteUtc) as { date: string } | undefined;
  if (!row || /```schedule-review\s+\d{4}-\d{2}-\d{2}\s*```/.test(reply)) return reply;
  return `${reply}\n\n\`\`\`schedule-review ${row.date}\`\`\``;
}

export function editScheduleItem(
  id: number,
  changes: Partial<Pick<ScheduleItemRow, "title" | "start" | "end" | "description" | "account">>
): ScheduleItemRow {
  const item = getScheduleItem(id);
  if (!item) throw new Error("Schedule item not found");
  if (item.status !== "proposed") throw new Error("Only a proposed item can be edited");
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of ["title", "start", "end", "description", "account"] as const) {
    if (changes[k] !== undefined) {
      sets.push(`${k}=?`);
      vals.push(changes[k]);
    }
  }
  if (sets.length) db.prepare(`UPDATE schedule_items SET ${sets.join(", ")} WHERE id=?`).run(...vals, id);
  return getScheduleItem(id)!;
}

export function rejectScheduleItem(id: number): ScheduleItemRow {
  const item = getScheduleItem(id);
  if (!item) throw new Error("Schedule item not found");
  if (item.status !== "proposed") throw new Error("Already decided");
  db.prepare(`UPDATE schedule_items SET status='rejected' WHERE id=?`).run(id);
  return getScheduleItem(id)!;
}

/** Approve one item: write it to the calendar (right now, this call), then record the result.
 *  Owner clicking Approve on this specific row IS the approval — no further gate needed. */
export async function approveScheduleItem(id: number): Promise<ScheduleItemRow> {
  const item = getScheduleItem(id);
  if (!item) throw new Error("Schedule item not found");
  if (item.status !== "proposed") throw new Error("Already decided");
  const existing = await findExistingCalendarEvent({ summary: item.title, start: item.start, end: item.end });
  let event: { id: string; account: string };
  if (existing) {
    event = existing;
  } else {
    const { createEvent } = await import("./gcal");
    event = await createEvent({
      summary: item.title,
      start: item.start,
      end: item.end,
      description: item.description || undefined,
      account: item.account || undefined,
    });
  }
  db.prepare(`UPDATE schedule_items SET status='approved', calendar_event_id=?, calendar_account=? WHERE id=?`).run(event.id, event.account, id);
  return getScheduleItem(id)!;
}

// ---------------------------------------------------------------- catch-up idempotency
// If the server was asleep at 8:30am, the next thing that calls dailyScheduleDue() (server boot,
// the 8:30 cron itself, or the /15 triage tick) runs it once and marks the date done. Never a
// silent skip, never a double-run for the same Central date.

export const DAILY_SCHEDULE_JOB = "daily_schedule";
const DAILY_SCHEDULE_MINUTE = 8 * 60 + 30; // 8:30am Central

export function dailyScheduleDue(now: Date = new Date()): boolean {
  if (centralMinuteOfDay(now) < DAILY_SCHEDULE_MINUTE) return false;
  return !jobAlreadyRan(DAILY_SCHEDULE_JOB, centralDateKey(now));
}

export function markDailyScheduleRan(now: Date = new Date()) {
  recordJobRun(DAILY_SCHEDULE_JOB, centralDateKey(now));
}

export const EVENT_PREP_JOB = "event_prep";

export function eventPrepDone(account: string, eventId: string): boolean {
  return jobAlreadyRan(EVENT_PREP_JOB, `${account}:${eventId}`);
}

export function markEventPrepped(account: string, eventId: string) {
  recordJobRun(EVENT_PREP_JOB, `${account}:${eventId}`);
}

// ---------------------------------------------------------------- evening shutdown + weekly review
// Same catch-up rule as the daily schedule: if the server was asleep at the set time, it runs once
// as soon as it wakes, but only on the same Central day (a missed Friday shutdown doesn't run Saturday,
// a missed Saturday review doesn't run Sunday). Never twice for one date.

export const EVENING_SHUTDOWN_JOB = "evening_shutdown";
export const EVENING_SHUTDOWN_MINUTE = 18 * 60; // 6:00pm Central, Monday-Friday
export const WEEKLY_REVIEW_JOB = "weekly_review";
export const WEEKLY_REVIEW_MINUTE = 9 * 60; // 9:00am Central, Saturdays
export const WEEKLY_REVIEW_DOW = 6; // Saturday

export function eveningShutdownDue(now: Date = new Date()): boolean {
  const { dow } = centralHourDow(now);
  if (dow < 1 || dow > 5) return false;
  if (centralMinuteOfDay(now) < EVENING_SHUTDOWN_MINUTE) return false;
  return !jobAlreadyRan(EVENING_SHUTDOWN_JOB, centralDateKey(now));
}

export function weeklyReviewDue(now: Date = new Date()): boolean {
  if (centralHourDow(now).dow !== WEEKLY_REVIEW_DOW) return false;
  if (centralMinuteOfDay(now) < WEEKLY_REVIEW_MINUTE) return false;
  return !jobAlreadyRan(WEEKLY_REVIEW_JOB, centralDateKey(now));
}

export function markRan(job: string, now: Date = new Date()) {
  recordJobRun(job, centralDateKey(now));
}
