// Shared iCalendar parsing, RRULE expansion and VEVENT building for every CalDAV provider
// (gcal-caldav.ts talks to Google, icloud-caldav.ts talks to Apple). Nothing in here does
// network I/O — each provider owns its own auth, discovery and fetch wrapper, and calls into
// these pure functions to parse what comes back / build what it sends.

export type DavEvent = {
  id: string;
  account: string;
  uid: string;
  summary: string;
  description: string;
  start: string; // ISO (UTC), or YYYY-MM-DD for all-day
  end: string;
  allDay: boolean;
  attendees: string[];
  organizer: string;
  status: string; // confirmed | tentative | cancelled
  transparent: boolean; // "show as free"
  recurring: boolean;
  recurrence: string; // RRULE text without the "RRULE:" prefix, "" when none
  htmlLink: string;
};

export function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

export type Prop = { name: string; params: Record<string, string>; value: string };

export function parseLine(line: string): Prop | null {
  const i = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/); // first colon not inside quotes
  if (i < 0) return null;
  const [name, ...rawParams] = line.slice(0, i).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const [k, v] = p.split("=");
    if (k) params[k.toUpperCase()] = (v || "").replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

export const unescapeText = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
export const escapeText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

/** Offset (ms) of a time zone at a given UTC instant. */
export function tzOffsetMs(tz: string, utc: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utc));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utc;
}

/** iCal date/time → ISO (UTC) or YYYY-MM-DD for all-day. */
export function toIso(p: Prop): { iso: string; allDay: boolean } {
  const v = p.value;
  if (p.params.VALUE === "DATE" || /^\d{8}$/.test(v)) return { iso: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, allDay: true };
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return { iso: v, allDay: false };
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7] === "Z") return { iso: new Date(wall).toISOString(), allDay: false };
  let tz = p.params.TZID || "America/Chicago";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = "America/Chicago"; // Outlook-style names ("Central Standard Time") → business time zone
  }
  // Wall-clock time in tz → UTC (two passes handle DST edges).
  let utc = wall - tzOffsetMs(tz, wall);
  utc = wall - tzOffsetMs(tz, utc);
  return { iso: new Date(utc).toISOString(), allDay: false };
}

export function durationMs(d: string): number {
  const m = d.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, sign, w, dd, h, mi, s] = m;
  const ms = ((+w || 0) * 7 * 86400 + (+dd || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0)) * 1000;
  return sign === "-" ? -ms : ms;
}

export const mailto = (v: string) => v.replace(/^mailto:/i, "").toLowerCase();

// ---------------------------------------------------------------- recurring events
// Providers' CalDAV servers may ignore the <expand> request, so repeating events can arrive as
// one master VEVENT (with RRULE / EXDATE) plus one VEVENT per changed occurrence
// (RECURRENCE-ID). We expand them here, in the event's own time zone so "every Tuesday 10am"
// stays 10am across DST changes.

export type Wall = { y: number; m: number; d: number; h: number; mi: number; s: number };
export const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function validTz(tz?: string) {
  try {
    if (tz) {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    }
  } catch {}
  return "America/Chicago";
}

export function wallOf(p: Prop): { wall: Wall; tz: string | null; allDay: boolean } | null {
  const v = p.value;
  if (p.params.VALUE === "DATE" || /^\d{8}$/.test(v))
    return { wall: { y: +v.slice(0, 4), m: +v.slice(4, 6), d: +v.slice(6, 8), h: 0, mi: 0, s: 0 }, tz: null, allDay: true };
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  return { wall: { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] }, tz: m[7] === "Z" ? "UTC" : validTz(p.params.TZID), allDay: false };
}

export function wallToUtc(w: Wall, tz: string): number {
  const wall = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  if (tz === "UTC") return wall;
  let utc = wall - tzOffsetMs(tz, wall);
  utc = wall - tzOffsetMs(tz, utc);
  return utc;
}

export const addDays = (w: Wall, n: number): Wall => {
  const t = new Date(Date.UTC(w.y, w.m - 1, w.d + n));
  return { ...w, y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
export const dow = (w: Wall) => new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Occurrence start dates (wall clock) of an RRULE, in order, from dtstart until `hiWall`-ish. */
export function* occurrences(rule: Record<string, string>, start: Wall, stopAfter: (w: Wall) => boolean): Generator<Wall> {
  const freq = rule.FREQ;
  const interval = Math.max(1, Number(rule.INTERVAL || 1));
  const byday = (rule.BYDAY || "").split(",").filter(Boolean);
  const bymonthday = (rule.BYMONTHDAY || "").split(",").filter(Boolean).map(Number);
  let guard = 0;
  if (freq === "DAILY") {
    for (let w = start; guard++ < 20000; w = addDays(w, interval)) {
      if (stopAfter(w)) return;
      if (!byday.length || byday.includes(DAYS[dow(w)])) yield w;
    }
  } else if (freq === "WEEKLY") {
    const wkst = DAYS.indexOf(rule.WKST || "MO");
    const days = byday.length ? byday.map((d) => DAYS.indexOf(d.slice(-2))) : [dow(start)];
    let weekStart = addDays(start, -((dow(start) - wkst + 7) % 7));
    for (; guard++ < 5000; weekStart = addDays(weekStart, 7 * interval)) {
      const inWeek = days
        .map((d) => addDays(weekStart, (d - wkst + 7) % 7))
        .sort((a, b) => Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d));
      for (const w of inWeek) {
        if (Date.UTC(w.y, w.m - 1, w.d) < Date.UTC(start.y, start.m - 1, start.d)) continue;
        if (stopAfter(w)) return;
        yield w;
      }
    }
  } else if (freq === "MONTHLY" || freq === "YEARLY") {
    let { y, m } = start;
    for (; guard++ < 3000; ) {
      const cands: Wall[] = [];
      if (freq === "YEARLY" && m !== start.m) {
        // yearly: only the start month
      } else if (byday.length) {
        for (const bd of byday) {
          const mm = bd.match(/^([+-]?\d+)?(\w\w)$/);
          if (!mm) continue;
          const want = DAYS.indexOf(mm[2]);
          const all: number[] = [];
          for (let d = 1; d <= daysInMonth(y, m); d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === want) all.push(d);
          const n = mm[1] ? Number(mm[1]) : 0;
          const picks = n === 0 ? all : [n > 0 ? all[n - 1] : all[all.length + n]];
          for (const d of picks) if (d) cands.push({ ...start, y, m, d });
        }
      } else {
        const mdays = bymonthday.length ? bymonthday : [start.d];
        for (const md of mdays) {
          const d = md > 0 ? md : daysInMonth(y, m) + md + 1;
          if (d >= 1 && d <= daysInMonth(y, m)) cands.push({ ...start, y, m, d });
        }
      }
      cands.sort((a, b) => a.d - b.d);
      for (const w of cands) {
        if (Date.UTC(w.y, w.m - 1, w.d) < Date.UTC(start.y, start.m - 1, start.d)) continue;
        if (stopAfter(w)) return;
        yield w;
      }
      const step = freq === "YEARLY" ? 12 * interval : interval;
      m += step;
      while (m > 12) { m -= 12; y++; }
    }
  }
}

export type RawEvent = { props: Prop[]; get: (n: string) => Prop | undefined; all: (n: string) => Prop[] };

export function rawEvents(ics: string): RawEvent[] {
  const lines = unfold(ics);
  const out: RawEvent[] = [];
  let cur: Prop[] | null = null;
  let depth = 0; // skip nested VALARMs
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = [];
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (line === "END:VEVENT") {
      const props = cur;
      out.push({ props, get: (n) => props.find((p) => p.name === n), all: (n) => props.filter((p) => p.name === n) });
      cur = null;
      continue;
    }
    if (line.startsWith("BEGIN:")) depth++;
    else if (line.startsWith("END:")) depth--;
    else if (depth === 0) {
      const p = parseLine(line);
      if (p) cur.push(p);
    }
  }
  return out;
}

function toDavEvent(ev: RawEvent, href: string, account: string, recurring: boolean, recurrence: string, startIso?: string, endIso?: string): DavEvent | null {
  const dtStart = ev.get("DTSTART");
  if (!dtStart) return null;
  const start = toIso(dtStart);
  let end = startIso && endIso ? endIso : start.iso;
  if (!startIso) {
    const dtEnd = ev.get("DTEND");
    const dur = ev.get("DURATION");
    if (dtEnd) end = toIso(dtEnd).iso;
    else if (dur && !start.allDay) end = new Date(new Date(start.iso).getTime() + durationMs(dur.value)).toISOString();
  }
  return {
    id: href,
    account,
    uid: ev.get("UID")?.value || href,
    summary: unescapeText(ev.get("SUMMARY")?.value || "(no title)"),
    description: unescapeText(ev.get("DESCRIPTION")?.value || ""),
    start: startIso || start.iso,
    end,
    allDay: start.allDay,
    attendees: ev.all("ATTENDEE").map((p) => mailto(p.value)),
    organizer: mailto(ev.get("ORGANIZER")?.value || ""),
    status: (ev.get("STATUS")?.value || "CONFIRMED").toLowerCase(),
    transparent: (ev.get("TRANSP")?.value || "").toUpperCase() === "TRANSPARENT",
    recurring,
    recurrence,
    htmlLink: "",
  };
}

/** Every occurrence of the events in one CalDAV resource that overlaps [lo, hi) (ms). */
export function parseEvents(ics: string, href: string, account: string, lo = -Infinity, hi = Infinity): DavEvent[] {
  const events = rawEvents(ics);
  const master = events.find((e) => e.get("RRULE") && !e.get("RECURRENCE-ID"));
  const overrides = events.filter((e) => e.get("RECURRENCE-ID"));
  const overlaps = (e: DavEvent) =>
    e.allDay ? e.end >= new Date(lo).toISOString().slice(0, 10) && e.start <= new Date(hi).toISOString().slice(0, 10) : new Date(e.end).getTime() > lo && new Date(e.start).getTime() < hi;

  if (!master) {
    return events.map((e) => toDavEvent(e, href, account, !!e.get("RECURRENCE-ID"), "")).filter((e): e is DavEvent => !!e && overlaps(e));
  }
  const masterRule = master.get("RRULE")?.value || "";
  if (lo === -Infinity) return [toDavEvent(master, href, account, true, masterRule)!]; // single lookup: the series itself

  const ds = wallOf(master.get("DTSTART")!);
  if (!ds) return [];
  const tz = ds.tz || "UTC";
  const base = toDavEvent(master, href, account, true, masterRule)!;
  const lengthMs = ds.allDay ? 0 : new Date(base.end).getTime() - new Date(base.start).getTime();
  const lengthDays = ds.allDay ? Math.max(1, Math.round((Date.parse(base.end) - Date.parse(base.start)) / 864e5)) : 0;
  const rule: Record<string, string> = {};
  for (const part of master.get("RRULE")!.value.split(";")) {
    const [k, v] = part.split("=");
    rule[k.toUpperCase()] = v;
  }
  const until = rule.UNTIL ? wallOf({ name: "UNTIL", params: {}, value: rule.UNTIL }) : null;
  const untilMs = until ? (until.allDay ? Date.UTC(until.wall.y, until.wall.m - 1, until.wall.d, 23, 59, 59) : wallToUtc(until.wall, until.tz || "UTC")) : Infinity;
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const instantOf = (w: Wall) => (ds.allDay ? Date.UTC(w.y, w.m - 1, w.d) : wallToUtc(w, tz));
  const key = (ms: number) => (ds.allDay ? new Date(ms).toISOString().slice(0, 10) : String(ms));

  const skipped = new Set<string>();
  for (const ex of master.all("EXDATE")) {
    for (const v of ex.value.split(",")) {
      const w = wallOf({ ...ex, value: v });
      if (w) skipped.add(key(w.allDay ? Date.UTC(w.wall.y, w.wall.m - 1, w.wall.d) : wallToUtc(w.wall, w.tz || tz)));
    }
  }
  const changed = new Map<string, RawEvent>();
  for (const o of overrides) {
    const w = wallOf(o.get("RECURRENCE-ID")!);
    if (w) changed.set(key(w.allDay ? Date.UTC(w.wall.y, w.wall.m - 1, w.wall.d) : wallToUtc(w.wall, w.tz || tz)), o);
  }

  const out: DavEvent[] = [];
  let n = 0;
  for (const w of occurrences(rule, ds.wall, (w) => instantOf(w) > untilMs || instantOf(w) >= hi || n >= count)) {
    n++;
    const at = instantOf(w);
    const k = key(at);
    if (skipped.has(k) || changed.has(k)) continue;
    const inst: DavEvent = ds.allDay
      ? { ...base, start: new Date(at).toISOString().slice(0, 10), end: new Date(at + lengthDays * 864e5).toISOString().slice(0, 10) }
      : { ...base, start: new Date(at).toISOString(), end: new Date(at + lengthMs).toISOString() };
    if (overlaps(inst)) out.push(inst);
  }
  for (const o of changed.values()) {
    const e = toDavEvent(o, href, account, true, masterRule);
    if (e && e.status !== "cancelled" && overlaps(e)) out.push(e);
  }
  return out;
}

export const icalUtc = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// ---------------------------------------------------------------- operations

export function parseMultistatus(xml: string): { href: string; etag: string; data: string }[] {
  const out: { href: string; etag: string; data: string }[] = [];
  for (const block of xml.split(/<D:response\b[^>]*>/i).slice(1)) {
    const href = block.match(/<D:href>([^<]+)<\/D:href>/i)?.[1] || "";
    const etag = block.match(/<D:getetag>([^<]+)<\/D:getetag>/i)?.[1] || "";
    const raw = block.match(/<(?:caldav|C|cal):calendar-data[^>]*>([\s\S]*?)<\/(?:caldav|C|cal):calendar-data>/i)?.[1] || "";
    const data = raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#13;/g, "\r");
    if (href && data) out.push({ href, etag, data });
  }
  return out;
}

// ---------------------------------------------------------------- repeat rules

const CHICAGO = "America/Chicago";
const RULE_KEYS = ["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "COUNT", "UNTIL", "WKST"];
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** Validate a repeat rule and return it normalized (no "RRULE:" prefix, uppercase). Only the
 *  parts parseEvents/occurrences() can actually expand are accepted. */
export function normalizeRecurrence(input: string): string {
  if (/[\x00-\x1f\x7f]/.test(input)) throw new Error("Recurrence rule must be a single line with no control characters");
  const text = input.replace(/^RRULE:/i, "").trim().toUpperCase();
  const rule: Record<string, string> = {};
  const parts = text.split(";");
  for (const part of parts) {
    const kv = part.split("=");
    if (kv.length !== 2 || !kv[0] || !kv[1]) throw new Error(`Bad recurrence part "${part}"; each part must be KEY=VALUE`);
    if (!RULE_KEYS.includes(kv[0])) throw new Error(`Unsupported recurrence part ${kv[0]}; supported: ${RULE_KEYS.join(", ")}`);
    if (kv[0] in rule) throw new Error(`Duplicate recurrence part ${kv[0]}`);
    rule[kv[0]] = kv[1];
  }
  if (!rule.FREQ) throw new Error("Recurrence needs FREQ");
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.FREQ)) throw new Error("FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY");
  const monthly = rule.FREQ === "MONTHLY" || rule.FREQ === "YEARLY";
  const out: string[] = [];
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (k === "INTERVAL") {
      if (!/^\d{1,2}$/.test(v) || +v < 1 || +v > 99) throw new Error("INTERVAL must be 1 to 99");
    } else if (k === "BYDAY") {
      for (const d of v.split(",")) {
        if (!/^(?:[+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/.test(d)) throw new Error(`Bad BYDAY value ${d}`);
        if (/\d/.test(d) && !monthly) throw new Error("A numbered BYDAY (like 1TH or -1FR) needs FREQ=MONTHLY or YEARLY");
      }
    } else if (k === "BYMONTHDAY") {
      if (!monthly) throw new Error("BYMONTHDAY needs FREQ=MONTHLY or YEARLY");
      if (rule.BYDAY) throw new Error("Use BYDAY or BYMONTHDAY, not both");
      for (const d of v.split(",")) {
        if (!/^[+-]?\d{1,2}$/.test(d) || +d === 0 || Math.abs(+d) > 31) throw new Error(`Bad BYMONTHDAY value ${d}`);
      }
    } else if (k === "COUNT") {
      if (!/^\d{1,3}$/.test(v) || +v < 1 || +v > 730) throw new Error("COUNT must be 1 to 730");
      if (rule.UNTIL) throw new Error("Use COUNT or UNTIL, not both");
    } else if (k === "UNTIL") {
      const m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (m) {
        const [y, mo, d] = [+m[1], +m[2], +m[3]];
        const t = new Date(Date.UTC(y, mo - 1, d));
        if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) throw new Error("UNTIL is not a real date");
        const utc = wallToUtc({ y, m: mo, d, h: 23, mi: 59, s: 59 }, CHICAGO);
        out.push(`UNTIL=${new Date(utc).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`);
        continue;
      }
      if (!/^\d{8}T\d{6}Z$/.test(v)) throw new Error("UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSSZ");
    } else if (k === "WKST") {
      if (!WEEKDAYS.includes(v)) throw new Error("WKST must be MO..SU");
    }
    out.push(part);
  }
  return out.join(";");
}

const parseRule = (rule: string): Record<string, string> => {
  const r: Record<string, string> = {};
  for (const part of rule.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = part.split("=");
    r[k.toUpperCase()] = v;
  }
  return r;
};

/** Central wall time of an ISO instant, as YYYYMMDDTHHMMSS. */
const chicagoWall = (iso: string) => {
  const ms = new Date(iso).getTime();
  return new Date(ms + tzOffsetMs(CHICAGO, ms)).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
};

/** Throws unless `startIso` (or a bare YYYY-MM-DD) is itself the first occurrence of the rule. */
export function assertStartMatchesRule(rule: string, startIso: string): void {
  let wall: Wall;
  if (/^\d{4}-\d{2}-\d{2}$/.test(startIso)) {
    wall = { y: +startIso.slice(0, 4), m: +startIso.slice(5, 7), d: +startIso.slice(8, 10), h: 0, mi: 0, s: 0 };
  } else {
    const ms = new Date(startIso).getTime();
    if (Number.isNaN(ms)) throw new Error(`Bad start ${startIso}`);
    const t = new Date(ms + tzOffsetMs(CHICAGO, ms));
    wall = { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
  }
  const first = occurrences(parseRule(rule), wall, () => false).next().value as Wall | undefined;
  if (!first) throw new Error("That rule never occurs from this start");
  if (first.y !== wall.y || first.m !== wall.m || first.d !== wall.d) {
    const p = (n: number, l = 2) => String(n).padStart(l, "0");
    throw new Error(`The first occurrence of that rule is ${p(first.y, 4)}-${p(first.m)}-${p(first.d)}, but start is on a different day; set start to the first occurrence`);
  }
}

/** US Central time zone definition, needed once an event carries TZID=America/Chicago. */
export function vtimezoneChicago(): string[] {
  return [
    "BEGIN:VTIMEZONE",
    "TZID:America/Chicago",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:-0600",
    "TZOFFSETTO:-0500",
    "TZNAME:CDT",
    "DTSTART:19700308T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:-0500",
    "TZOFFSETTO:-0600",
    "TZNAME:CST",
    "DTSTART:19701101T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
}

/** What an update does to an event's repeat rule: nothing, add one to a one-off (no approval),
 *  or change an existing series' rule (needs Owner's approval). */
export function planRecurrenceUpdate(
  current: { recurring?: boolean; recurrence?: string },
  requested?: string
): { kind: "none" | "add" | "change"; rule?: string } {
  if (requested === undefined || requested === "") return { kind: "none" };
  const rule = normalizeRecurrence(requested);
  if (!current.recurring && !current.recurrence) return { kind: "add", rule };
  const cur = (current.recurrence || "").replace(/^RRULE:/i, "").trim().toUpperCase();
  if (cur === rule) return { kind: "none" };
  return { kind: "change", rule };
}

export function veventLines(opts: {
  uid: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
  status?: string;
  attendees?: string[];
  organizer: string;
  recurrence?: string;
}) {
  const rule = opts.recurrence ? normalizeRecurrence(opts.recurrence) : "";
  if (rule) assertStartMatchesRule(rule, opts.start);
  const lines = [
    "BEGIN:VEVENT",
    `UID:${opts.uid}`,
    `DTSTAMP:${icalUtc(new Date().toISOString())}`,
    ...(rule
      ? [`DTSTART;TZID=${CHICAGO}:${chicagoWall(opts.start)}`, `DTEND;TZID=${CHICAGO}:${chicagoWall(opts.end)}`, `RRULE:${rule}`]
      : [`DTSTART:${icalUtc(opts.start)}`, `DTEND:${icalUtc(opts.end)}`]),
    `SUMMARY:${escapeText(opts.summary)}`,
    `STATUS:${(opts.status || "confirmed").toUpperCase()}`,
  ];
  if (opts.description) lines.push(`DESCRIPTION:${escapeText(opts.description)}`);
  if (opts.attendees?.length) {
    lines.push(`ORGANIZER:mailto:${opts.organizer}`);
    for (const a of opts.attendees) lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`);
  }
  lines.push("END:VEVENT");
  return lines;
}

/** Rewrite an existing VEVENT's properties in place (used by update flows), keeping everything
 *  not being changed (alarms, conferencing, etc.). Throws if the resource is part of a
 *  recurring series (editing one occurrence isn't supported; ask Owner to change it himself). */
export function updateIcsBody(
  ics: string,
  change: {
    summary?: string;
    start?: string;
    end?: string;
    description?: string;
    status?: string;
    attendees?: string[];
    organizer: string;
    recurrence?: string;
    allowRuleChange?: boolean;
  }
): string {
  if (!change.recurrence) {
    if (/^(RRULE|RECURRENCE-ID)[:;]/m.test(ics)) throw new Error("This is a recurring event; ask Owner to change the series himself.");
  }
  let newRule = "";
  let seriesRuleOnly = false;
  let addVtimezone = false;
  let rewriteTimes: { start: string; end: string } | null = null;
  if (change.recurrence) {
    const evs = rawEvents(ics);
    if (evs.some((e) => e.get("RECURRENCE-ID"))) throw new Error("This is a recurring event; ask Owner to change the series himself.");
    const masterEv = evs.find((e) => e.get("RRULE"));
    if (masterEv) {
      if (!change.allowRuleChange) throw new Error("Changing a repeating event's rule needs Owner's approval; ask through update_calendar_event");
      if ([change.summary, change.start, change.end, change.description, change.status, change.attendees].some((v) => v !== undefined))
        throw new Error("Change the repeat rule on its own");
      newRule = normalizeRecurrence(change.recurrence);
      assertStartMatchesRule(newRule, toIso(masterEv.get("DTSTART")!).iso);
      seriesRuleOnly = true;
    } else {
      newRule = normalizeRecurrence(change.recurrence);
      const dtStart = evs[0]?.get("DTSTART");
      if (!dtStart) throw new Error("Event has no start time");
      const cur = toIso(dtStart);
      assertStartMatchesRule(newRule, change.start ?? cur.iso);
      if (!(cur.allDay && change.start === undefined && change.end === undefined)) {
        const startIso = change.start ?? cur.iso;
        let endIso = change.end;
        if (endIso === undefined) {
          const dtEnd = evs[0].get("DTEND");
          const dur = evs[0].get("DURATION");
          endIso = dtEnd ? toIso(dtEnd).iso : dur ? new Date(new Date(startIso).getTime() + durationMs(dur.value)).toISOString() : startIso;
        }
        rewriteTimes = { start: startIso, end: endIso };
      }
      addVtimezone = !/^BEGIN:VTIMEZONE/m.test(ics);
    }
  }
  if (seriesRuleOnly) {
    let inEv = false;
    let d = 0;
    return unfold(ics)
      .map((line) => {
        if (line === "BEGIN:VEVENT") { inEv = true; d = 0; }
        else if (inEv && line.startsWith("BEGIN:")) d++;
        else if (inEv && line.startsWith("END:") && line !== "END:VEVENT") d--;
        else if (line === "END:VEVENT") inEv = false;
        if (inEv && d === 0 && parseLine(line)?.name === "RRULE") return `RRULE:${newRule}`;
        return line;
      })
      .join("\r\n");
  }
  const replace: Record<string, string[] | undefined> = {
    SUMMARY: change.summary !== undefined ? [`SUMMARY:${escapeText(change.summary)}`] : undefined,
    DTSTART: rewriteTimes
      ? [`DTSTART;TZID=${CHICAGO}:${chicagoWall(rewriteTimes.start)}`]
      : change.start !== undefined
        ? [`DTSTART:${icalUtc(change.start)}`]
        : undefined,
    DTEND: rewriteTimes
      ? [`DTEND;TZID=${CHICAGO}:${chicagoWall(rewriteTimes.end)}`]
      : change.end !== undefined
        ? [`DTEND:${icalUtc(change.end)}`]
        : undefined,
    DURATION: rewriteTimes || change.end !== undefined ? [] : undefined,
    DESCRIPTION: change.description !== undefined ? [`DESCRIPTION:${escapeText(change.description)}`] : undefined,
    STATUS: change.status !== undefined ? [`STATUS:${change.status.toUpperCase()}`] : undefined,
    ATTENDEE: change.attendees !== undefined ? change.attendees.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`) : undefined,
  };
  const lines = unfold(ics);
  const out: string[] = [];
  let inEvent = false;
  let depth = 0;
  let hasOrganizer = false;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      if (addVtimezone) { out.push(...vtimezoneChicago()); addVtimezone = false; }
      inEvent = true;
      depth = 0;
    } else if (inEvent && line.startsWith("BEGIN:")) depth++;
    else if (inEvent && line.startsWith("END:") && line !== "END:VEVENT") depth--;
    if (inEvent && depth === 0 && line !== "BEGIN:VEVENT" && line !== "END:VEVENT") {
      const name = parseLine(line)?.name;
      if (name === "ORGANIZER") hasOrganizer = true;
      if (name && replace[name] !== undefined) continue; // dropped; re-added below
    }
    if (line === "END:VEVENT" && inEvent) {
      for (const v of Object.values(replace)) if (v) out.push(...v);
      if (newRule) out.push(`RRULE:${newRule}`);
      if (change.attendees?.length && !hasOrganizer) out.push(`ORGANIZER:mailto:${change.organizer}`);
      inEvent = false;
    }
    out.push(line);
  }
  return out.join("\r\n");
}
