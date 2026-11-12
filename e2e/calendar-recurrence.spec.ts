import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  assertStartMatchesRule,
  normalizeRecurrence,
  parseEvents,
  planRecurrenceUpdate,
  unfold,
  updateIcsBody,
  veventLines,
  vtimezoneChicago,
} from "../src/lib/caldav-ical";
import { toCalendarEvent } from "../src/lib/gcal";

// Network-free: pure parsing/building and source-level guards. Never sends, never runs an agent.

const buildIcs = (recurrence: string | undefined, start: string, end: string) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GenLimitless OS//EN",
    ...(recurrence ? vtimezoneChicago() : []),
    ...veventLines({ summary: "Standup", start, end, recurrence, uid: "t@x", organizer: "a@b.c" }),
    "END:VCALENDAR",
    "",
  ].join("\r\n");

const centralDate = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const FRI = "FREQ=WEEKLY;BYDAY=FR";
const oneOff = () => buildIcs(undefined, "2026-10-09T10:00:00-05:00", "2026-10-09T10:30:00-05:00");
const series = () => buildIcs(FRI, "2026-10-09T10:00:00-05:00", "2026-10-09T10:30:00-05:00");

test("weekly Friday round trip across the DST change", () => {
  const ics = series();
  const single = parseEvents(ics, "/h", "acct");
  expect(single).toHaveLength(1);
  expect(single[0].recurring).toBe(true);
  expect(single[0].recurrence).toBe(FRI);
  const lo = Date.parse("2026-10-09T00:00:00-05:00");
  const hi = Date.parse("2026-11-07T00:00:00-06:00");
  const evs = parseEvents(ics, "/h", "acct", lo, hi);
  expect(evs.map((e) => e.start)).toEqual([
    "2026-10-09T15:00:00.000Z",
    "2026-10-16T15:00:00.000Z",
    "2026-10-23T15:00:00.000Z",
    "2026-10-30T15:00:00.000Z",
    "2026-11-06T16:00:00.000Z",
  ]);
  for (const e of evs) {
    expect(e.recurrence).toBe(FRI);
    expect(e.recurring).toBe(true);
  }
});

test("monthly ordinals", () => {
  const first = parseEvents(buildIcs("FREQ=MONTHLY;BYDAY=1TH", "2026-10-01T10:00:00-05:00", "2026-10-01T11:00:00-05:00"), "/h", "a", Date.parse("2026-10-01T00:00:00-05:00"), Date.parse("2027-01-01T00:00:00-06:00"));
  expect(first.map((e) => centralDate(e.start))).toEqual(["2026-10-01", "2026-11-05", "2026-12-03"]);
  const sat = parseEvents(buildIcs("FREQ=MONTHLY;BYDAY=3SA,5SA", "2026-10-17T10:00:00-05:00", "2026-10-17T11:00:00-05:00"), "/h", "a", Date.parse("2026-10-17T00:00:00-05:00"), Date.parse("2027-02-01T00:00:00-06:00"));
  expect(sat.map((e) => centralDate(e.start))).toEqual(["2026-10-17", "2026-10-31", "2026-11-21", "2026-12-19", "2027-01-16", "2027-01-30"]);
});

test("COUNT and UNTIL", () => {
  const lo = Date.parse("2026-01-01T00:00:00Z");
  const hi = Date.parse("2027-01-01T00:00:00Z");
  const counted = parseEvents(buildIcs("FREQ=DAILY;COUNT=3", "2026-10-29T10:00:00-05:00", "2026-10-29T11:00:00-05:00"), "/h", "a", lo, hi);
  expect(counted).toHaveLength(3);
  const until = parseEvents(buildIcs("FREQ=DAILY;UNTIL=20261031", "2026-10-29T10:00:00-05:00", "2026-10-29T11:00:00-05:00"), "/h", "a", lo, hi);
  expect(until.map((e) => centralDate(e.start))).toEqual(["2026-10-29", "2026-10-30", "2026-10-31"]);
  expect(normalizeRecurrence("FREQ=DAILY;UNTIL=20261031")).toBe("FREQ=DAILY;UNTIL=20261101T045959Z");
});

test("rejections", () => {
  expect(() => normalizeRecurrence("FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR")).toThrow(/Unsupported recurrence part (BYSETPOS|BYMONTH); supported:/);
  expect(() => normalizeRecurrence("FREQ=YEARLY;BYMONTH=10")).toThrow(/Unsupported recurrence part (BYSETPOS|BYMONTH); supported:/);
  expect(() => normalizeRecurrence("FREQ=HOURLY")).toThrow();
  expect(() => normalizeRecurrence("FREQ=DAILY;COUNT=3;UNTIL=20261031")).toThrow(/COUNT or UNTIL/);
  expect(() => normalizeRecurrence("FREQ=WEEKLY\r\nATTENDEE:mailto:x@y.z")).toThrow();
  expect(() => normalizeRecurrence("FREQ=DAILY;EXDATE=20261010T100000Z")).toThrow(/Unsupported/);
  expect(() => normalizeRecurrence("FREQ=DAILY;DTSTART=20261010T100000Z")).toThrow(/Unsupported/);
  expect(() => normalizeRecurrence("FREQ=DAILY;FOO=1")).toThrow(/Unsupported/);
  expect(() => normalizeRecurrence("FREQ=DAILY;INTERVAL=0")).toThrow();
  expect(() => normalizeRecurrence("FREQ=DAILY;INTERVAL=100")).toThrow();
  expect(() => normalizeRecurrence("FREQ=DAILY;COUNT=731")).toThrow();
  expect(() => normalizeRecurrence("FREQ=WEEKLY;BYDAY=1MO")).toThrow();
  expect(() => normalizeRecurrence("FREQ=MONTHLY;BYMONTHDAY=0")).toThrow();
  expect(() => normalizeRecurrence("FREQ=MONTHLY;BYMONTHDAY=32")).toThrow();
  expect(() => normalizeRecurrence("FREQ=WEEKLY;BYMONTHDAY=5")).toThrow();
  expect(() => assertStartMatchesRule(FRI, "2026-10-10T10:00:00-05:00")).toThrow(/first occurrence of that rule is 2026-10-16.*different day/);
  expect(() => assertStartMatchesRule(FRI, "2026-10-09T10:00:00-05:00")).not.toThrow();
});

test("accepted forms and idempotence", () => {
  expect(normalizeRecurrence("RRULE:FREQ=WEEKLY;BYDAY=FR")).toBe(FRI);
  expect(normalizeRecurrence("freq=weekly;byday=fr")).toBe(FRI);
  for (const x of [FRI, "FREQ=DAILY;UNTIL=20261031", "FREQ=MONTHLY;BYDAY=3SA,5SA;INTERVAL=2"]) {
    expect(normalizeRecurrence(normalizeRecurrence(x))).toBe(normalizeRecurrence(x));
  }
});

test("one-off output is unchanged", () => {
  const lines = unfold(oneOff()).filter((l) => !l.startsWith("DTSTAMP:"));
  expect(lines).toEqual([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GenLimitless OS//EN",
    "BEGIN:VEVENT",
    "UID:t@x",
    "DTSTART:20261009T150000Z",
    "DTEND:20261009T153000Z",
    "SUMMARY:Standup",
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ]);
  const [ev] = parseEvents(oneOff(), "/h", "a");
  expect(ev.recurring).toBe(false);
  expect(ev.recurrence).toBe("");
});

test("Google mapper", () => {
  const s = { dateTime: "2026-10-09T10:00:00-05:00" };
  const m = toCalendarEvent({ id: "a", recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=FR"], start: s, end: s }, "acct");
  expect(m.recurring).toBe(true);
  expect(m.recurrence).toBe(FRI);
  expect(toCalendarEvent({ id: "a_20261016", recurringEventId: "a", start: s, end: s }, "acct").recurring).toBe(true);
  const plain = toCalendarEvent({ id: "b", start: s, end: s }, "acct");
  expect(plain.recurring).toBe(false);
  expect(plain.recurrence).toBe("");
});

const toolsSrc = fs.readFileSync(path.join(__dirname, "../src/lib/agents/tools.ts"), "utf8");
const block = (from: string, to: string) => {
  const a = toolsSrc.indexOf(`"${from}"`);
  const b = toolsSrc.indexOf(`"${to}"`, a);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return toolsSrc.slice(a, b);
};

test("create_calendar_event validates, then asks, then writes; cancel only asks", () => {
  const create = block("create_calendar_event", "update_calendar_event");
  const write = create.indexOf("createCalendarEvent(ev)");
  expect(write).toBeGreaterThan(-1);
  expect(create.indexOf("externalAttendees(")).toBeLessThan(write);
  expect(create.indexOf("createApprovalRequest(")).toBeLessThan(write);
  expect(create).toContain("(repeats ");
  const cancel = toolsSrc.slice(toolsSrc.indexOf(`"cancel_calendar_event"`), toolsSrc.indexOf(`"cancel_calendar_event"`) + 1500);
  expect(cancel).toContain("createApprovalRequest(");
  expect(cancel).not.toMatch(/cancelCalendarEvent|cancelEvent\(/);
});

test("planRecurrenceUpdate", () => {
  expect(planRecurrenceUpdate({ recurring: false, recurrence: "" }, FRI).kind).toBe("add");
  expect(planRecurrenceUpdate({ recurring: true, recurrence: "FREQ=DAILY" }, FRI).kind).toBe("change");
  expect(planRecurrenceUpdate({ recurring: true, recurrence: FRI }, "freq=weekly;byday=fr").kind).toBe("none");
  expect(planRecurrenceUpdate({ recurring: true, recurrence: FRI }, undefined).kind).toBe("none");
  expect(planRecurrenceUpdate({ recurring: true, recurrence: FRI }, "").kind).toBe("none");
});

test("adding a rule to a one-off needs no approval", () => {
  const out = updateIcsBody(oneOff(), { recurrence: FRI, start: "2026-10-09T10:00:00-05:00", organizer: "a@b.c" });
  expect(out).toContain(`RRULE:${FRI}`);
  expect(out).toContain("DTSTART;TZID=America/Chicago:20261009T100000");
  expect(out).toContain("BEGIN:VTIMEZONE");
  const [ev] = parseEvents(out, "/h", "a");
  expect(ev.recurring).toBe(true);
});

test("changing a series rule needs approval and touches only the RRULE line", () => {
  const ics = series();
  const copy = String(ics);
  const rule = "FREQ=WEEKLY;BYDAY=FR;COUNT=2";
  expect(() => updateIcsBody(ics, { recurrence: rule, organizer: "a@b.c" })).toThrow(/needs Owner's approval/);
  expect(ics).toBe(copy);
  const out = updateIcsBody(ics, { recurrence: rule, allowRuleChange: true, organizer: "a@b.c" }).split("\r\n");
  const before = unfold(ics);
  expect(out).toHaveLength(before.length);
  const diff = out.map((l, i) => (l === before[i] ? -1 : i)).filter((i) => i >= 0);
  expect(diff).toHaveLength(1);
  expect(out[diff[0]]).toBe(`RRULE:${rule}`);
  expect(() => updateIcsBody(ics, { recurrence: rule, allowRuleChange: true, summary: "x", organizer: "a@b.c" })).toThrow(/on its own/);
});

test("allowRuleChange: true only in approvals.ts; tools.ts discards it and asks before writing", () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(f.name) && fs.readFileSync(p, "utf8").includes("allowRuleChange: true")) hits.push(path.relative(path.join(__dirname, "../src"), p));
    }
  };
  walk(path.join(__dirname, "../src"));
  expect(hits).toEqual([path.join("lib", "agents", "approvals.ts")]);
  expect(toolsSrc).toContain("allowRuleChange: _discard");
  const update = block("update_calendar_event", "cancel_calendar_event");
  const change = update.slice(update.indexOf(`plan.kind === "change"`));
  expect(change.indexOf("createApprovalRequest(")).toBeGreaterThan(-1);
  expect(update.indexOf("createApprovalRequest(")).toBeLessThan(update.indexOf("updateCalendarEvent("));
});
