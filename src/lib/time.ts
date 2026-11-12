// GenLimitless runs on Central Time. Storage stays UTC (SQLite datetime('now')),
// and everything shown to Owner or chosen by the agent is Central.

export const BUSINESS_TZ = "America/Chicago";

/** Parse a stored timestamp: SQLite UTC ("2026-09-18 14:02:00") or ISO with/without offset. */
export function parseStored(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
  return isNaN(d.getTime()) ? null : d;
}

/** Date → SQLite UTC format, comparable with datetime('now'). */
export function toSqliteUtc(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** "Mon, Sep 21, 9:30 AM CDT" */
export function fmtCentral(d: Date | string | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  const date = typeof d === "string" ? parseStored(d) : d;
  if (!date) return "";
  return date.toLocaleString("en-US", {
    timeZone: BUSINESS_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...opts,
  });
}

/** Central UTC offset on a given date, e.g. "-05:00" (CDT) or "-06:00" (CST). */
export function centralOffset(d: Date = new Date()): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, timeZoneName: "longOffset" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")!.value; // "GMT-05:00"
  return name.replace("GMT", "") || "+00:00";
}

/** Current Central date/time as a line the agent can reason from. */
export function nowCentralForPrompt(): string {
  const now = new Date();
  return `${fmtCentral(now, { year: "numeric" })} (UTC offset ${centralOffset(now)})`;
}

/** Hour (0-23) and weekday (0=Sun..6=Sat) of an instant, in Central Time. */
export function centralHourDow(d: Date): { hour: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")!.value);
  return { hour, dow };
}

/** Central calendar date, 'YYYY-MM-DD' — the key for anything scoped to "today" (the daily
 *  schedule's catch-up idempotency, schedule_items.date, ...). */
export function centralDateKey(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Minutes since midnight, Central time (8:30am = 510). */
export function centralMinuteOfDay(d: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const minute = Number(parts.find((p) => p.type === "minute")!.value);
  return hour * 60 + minute;
}

/** [start, end) ISO instants spanning one Central calendar date, DST-safe. */
export function centralDayBounds(dateStr: string): { start: string; end: string } {
  const offsetFor = (ds: string) => centralOffset(new Date(`${ds}T12:00:00Z`));
  const next = new Date(`${dateStr}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextStr = next.toISOString().slice(0, 10);
  return {
    start: `${dateStr}T00:00:00${offsetFor(dateStr)}`,
    end: `${nextStr}T00:00:00${offsetFor(nextStr)}`,
  };
}

/** Split an instant into its Central date, 24h hour and minute. */
export function centralParts(d: Date): { date: string; hour24: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour24: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

function offsetMs(off: string): number {
  const m = /^([+-])(\d\d):(\d\d)$/.exec(off);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000;
}

/** Offset ISO for a Central wall-clock time, e.g. ('2026-06-15', 12, 45) → '2026-06-15T12:45:00-05:00'. */
export function centralToIso(date: string, hour24: number, minute: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour24, minute);
  const first = centralOffset(new Date(guess));
  const instant = guess - offsetMs(first);
  const offset = centralOffset(new Date(instant));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date}T${pad(hour24)}:${pad(minute)}:00${offset}`;
}

/** Central offset ISO of (stored timestamp + minutes). */
export function addMinutesIso(iso: string, minutes: number): string {
  const d = parseStored(iso) ?? new Date();
  const p = centralParts(new Date(d.getTime() + minutes * 60000));
  return centralToIso(p.date, p.hour24, p.minute);
}
