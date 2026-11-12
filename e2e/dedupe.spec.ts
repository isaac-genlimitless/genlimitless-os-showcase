import { test, expect } from "@playwright/test";
import { findDuplicateEvent, findDuplicateTask } from "../src/lib/dedupe";

// Pure-function tests: no calendar writes, no agent runs.
const T = "LinkedIn: 20 requests + Built follow-up";
const ev = (o: any) => ({ id: "1", account: "a", summary: T, description: "", start: "2026-10-28T12:45:00-05:00", end: "2026-10-28T14:00:00-05:00", attendees: [], status: "confirmed", htmlLink: "", ...o });
const cand = { summary: T, start: "2026-10-28T12:45:00-05:00", end: "2026-10-28T14:00:00-05:00" };

test("flags same title and time", () => {
  expect(findDuplicateEvent(cand, [ev({})])).toBeTruthy();
});

test("flags same title shifted 30 minutes", () => {
  const e = ev({ start: "2026-10-28T13:15:00-05:00", end: "2026-10-28T14:30:00-05:00" });
  expect(findDuplicateEvent(cand, [e])).toBeTruthy();
});

test("does not flag a different day", () => {
  const e = ev({ start: "2026-10-29T12:45:00-05:00", end: "2026-10-29T14:00:00-05:00" });
  expect(findDuplicateEvent(cand, [e])).toBeUndefined();
});

test("does not flag a different title at the same time", () => {
  expect(findDuplicateEvent(cand, [ev({ summary: "Dentist appointment" })])).toBeUndefined();
});

test("all-day same-date match", () => {
  const c = { summary: "Offsite", start: "2026-11-02", end: "2026-11-03", allDay: true };
  expect(findDuplicateEvent(c, [ev({ summary: "Offsite", start: "2026-11-02", end: "2026-11-03", allDay: true })])).toBeTruthy();
  expect(findDuplicateEvent(c, [ev({ summary: "Offsite", start: "2026-11-04", end: "2026-11-05", allDay: true })])).toBeUndefined();
});

test("cancelled events are ignored", () => {
  expect(findDuplicateEvent(cand, [ev({ status: "cancelled" })])).toBeUndefined();
});

test.describe("findDuplicateTask", () => {
  const task = (o: any): any => ({ id: 1, title: "", notes: null, category: null, status: "open", priority: "normal", due_date: null, created_by: "x", created_at: "", updated_at: "", completed_at: null, archived_at: null, ...o });

  test("detects questionnaire variants", () => {
    const t = task({ title: "Complete Life Portrait medical underwriting questionnaire (life insurance)" });
    expect(findDuplicateTask({ title: "Complete Life Portrait medical underwriting questionnaire (Farm Bureau life insurance)" }, [t])).toBeTruthy();
  });

  test("detects trade-in variants", () => {
    const t = task({ title: "Mail in iPhone 13 trade-in to CarrierCo" });
    expect(findDuplicateTask({ title: "Mail in iPhone 13 trade-in to CarrierCo (line ending 0000)" }, [t])).toBeTruthy();
  });

  test("does not flag different bills", () => {
    expect(findDuplicateTask({ title: "Pay Insurer bill" }, [task({ title: "Pay hosting bill" })])).toBeNull();
  });

  test("does not flag different Pace Carter tasks", () => {
    expect(findDuplicateTask({ title: "Check for Pace Carter reply" }, [task({ title: "Follow up with Pace Carter" })])).toBeNull();
  });

  test("ignores done and archived tasks", () => {
    const title = "Pay Insurer bill";
    expect(findDuplicateTask({ title }, [task({ title, status: "done" }), task({ title, archived_at: "2026-01-01" })])).toBeNull();
  });
});
