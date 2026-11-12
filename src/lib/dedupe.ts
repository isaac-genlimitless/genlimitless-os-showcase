import type { CalendarEvent } from "./gcal";
import type { Task } from "./tasks";

// Shared duplicate-guard helpers (title matching + calendar events).

export function normalizeTitle(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 0..1 similarity of two titles: 1 when normalized equal, else word-set Jaccard overlap. */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const sa = new Set(na.split(" "));
  const sb = new Set(nb.split(" "));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

type Candidate = { summary: string; start: string; end: string; allDay?: boolean };

const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function timesMatch(c: Candidate, e: CalendarEvent): boolean {
  const allDay = c.allDay || e.allDay || isDateOnly(c.start) || isDateOnly(e.start);
  if (allDay) return c.start.slice(0, 10) === e.start.slice(0, 10);
  const cs = Date.parse(c.start);
  const ce = Date.parse(c.end);
  const es = Date.parse(e.start);
  const ee = Date.parse(e.end);
  if ([cs, ce, es, ee].some(Number.isNaN)) return false;
  if (Math.abs(cs - es) <= 60 * 60000) return true;
  const overlap = Math.min(ce, ee) - Math.max(cs, es);
  const shorter = Math.min(ce - cs, ee - es);
  return shorter > 0 && overlap >= shorter * 0.5;
}

/** First non-cancelled event with a same/similar title at the same time, or undefined. */
export function findDuplicateEvent(candidate: Candidate, events: CalendarEvent[]): CalendarEvent | undefined {
  return events.find(
    (e) =>
      e.status !== "cancelled" &&
      (normalizeTitle(e.summary) === normalizeTitle(candidate.summary) || titleSimilarity(candidate.summary, e.summary) >= 0.8) &&
      timesMatch(candidate, e)
  );
}

type TaskCandidate = { title: string; due_date?: string | null; notes?: string | null };

function taskSimilarity(a: string, b: string): number {
  const base = titleSimilarity(a, b);
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return base;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.split(" ").length >= 4 && ` ${long} `.includes(` ${short} `)) return Math.max(base, 1);
  return base;
}

function datesClose(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return true;
  const da = Date.parse(a.slice(0, 10) + "T00:00:00Z");
  const db_ = Date.parse(b.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(da) || Number.isNaN(db_)) return true;
  return Math.abs(da - db_) <= 86400000;
}

function sourceRefs(notes?: string | null): Set<string> {
  const out = new Set<string>();
  const s = notes || "";
  for (const m of s.matchAll(/Files\s+#?(\d+)/gi)) out.add("file:" + m[1]);
  for (const m of s.matchAll(/\/files\?id=(\d+)/gi)) out.add("file:" + m[1]);
  for (const m of s.matchAll(/imap:(\d+)/gi)) out.add("imap:" + m[1]);
  return out;
}

/** First open, non-archived task that matches the candidate, or null. Pure: no db access. */
export function findDuplicateTask(candidate: TaskCandidate, openTasks: Task[]): Task | null {
  const nc = normalizeTitle(candidate.title);
  if (!nc) return null;
  const refs = sourceRefs(candidate.notes);
  for (const t of openTasks) {
    if (t.status !== "open" || t.archived_at) continue;
    if (normalizeTitle(t.title) === nc) return t;
    const sim = taskSimilarity(candidate.title, t.title);
    if (sim >= 0.7 && datesClose(candidate.due_date, t.due_date)) return t;
    if (sim >= 0.5 && refs.size) {
      for (const r of sourceRefs(t.notes)) if (refs.has(r)) return t;
    }
  }
  return null;
}

/** Look across ALL connected calendars for a duplicate. Fails open: any error returns null. */
export async function findExistingCalendarEvent(candidate: Candidate): Promise<CalendarEvent | null> {
  try {
    const s = Date.parse(candidate.start);
    const en = Date.parse(candidate.end);
    if (Number.isNaN(s) || Number.isNaN(en)) return null;
    const { listEvents } = await import("./gcal");
    const events = await listEvents({
      timeMin: new Date(s - 3 * 3600000).toISOString(),
      timeMax: new Date(en + 3 * 3600000).toISOString(),
    });
    return findDuplicateEvent(candidate, events) || null;
  } catch (err) {
    console.warn("[dedupe] calendar duplicate check failed (allowing creation):", (err as Error)?.message || err);
    return null;
  }
}
