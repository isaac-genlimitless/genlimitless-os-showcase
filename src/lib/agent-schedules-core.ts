import { centralDateKey, centralOffset } from "./time";
export type WeeklySpec = { dow: number; hour: number; minute: number }; // dow 0=Sun..6=Sat, Central Time
const p2 = (n: number) => String(n).padStart(2, "0");
const DAY = 86400e3;
function addDays(dateStr: string, n: number): string { return new Date(new Date(`${dateStr}T12:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10); }
const dowOf = (dateStr: string) => new Date(`${dateStr}T12:00:00Z`).getUTCDay();
/** The instant a weekly spec fires on a given Central date (DST-safe). */
export function occurrenceOn(dateStr: string, s: WeeklySpec): Date {
  return new Date(`${dateStr}T${p2(s.hour)}:${p2(s.minute)}:00${centralOffset(new Date(`${dateStr}T12:00:00Z`))}`);
}
/** Most recent occurrence at or before `now` (key = its Central date). */
export function lastOccurrence(s: WeeklySpec, now: Date = new Date()): { key: string; at: Date } | null {
  const today = centralDateKey(now);
  for (let i = 0; i <= 7; i++) { const ds = addDays(today, -i); if (dowOf(ds) !== s.dow) continue; const at = occurrenceOn(ds, s); if (at.getTime() <= now.getTime()) return { key: ds, at }; }
  return null;
}
export function nextOccurrence(s: WeeklySpec, now: Date = new Date()): { key: string; at: Date } | null {
  const today = centralDateKey(now);
  for (let i = 0; i <= 8; i++) { const ds = addDays(today, i); if (dowOf(ds) !== s.dow) continue; const at = occurrenceOn(ds, s); if (at.getTime() > now.getTime()) return { key: ds, at }; }
  return null;
}
/** Catch-up rule: the latest occurrence is due if it happened after the schedule was created and hasn't completed. */
export function dueOccurrence(s: WeeklySpec, now: Date, createdAt: Date, lastDoneKey: string | null) {
  const last = lastOccurrence(s, now);
  if (!last || last.at.getTime() <= createdAt.getTime() || last.key === lastDoneKey) return null;
  return last;
}
export const DOW_NAMES = ["Sundays","Mondays","Tuesdays","Wednesdays","Thursdays","Fridays","Saturdays"];
export function describeSpec(s: WeeklySpec): string { const h12 = s.hour % 12 || 12; return `${DOW_NAMES[s.dow]} at ${h12}:${p2(s.minute)} ${s.hour < 12 ? "AM" : "PM"} Central`; }
