import { test, expect } from "@playwright/test";
import db from "../src/lib/db";
import { filterUnhandled, handledCounts, markHandled, markHandledAndLabel } from "../src/lib/mail-ledger";

// Node-only: no network, never presses Send, never triggers an agent.
const acct = `ledger-${Date.now()}@example.test`;
const count = () => (db.prepare(`SELECT COUNT(*) c FROM mail_handled WHERE account = ?`).get(acct) as { c: number }).c;

test("handled message is skipped", () => {
  markHandled([{ account: acct, message_id: "a1", thread_id: "ta", decision: "noise" }]);
  const r = filterUnhandled(acct, [{ message_id: "a1", thread_id: "ta", date: "2020-01-01T00:00:00Z" }]);
  expect(r.fresh).toHaveLength(0);
  expect(r.skipped).toHaveLength(1);
});

test("newer message in a handled thread resurfaces", () => {
  markHandled([{ account: acct, message_id: "b1", thread_id: "tb", decision: "drafted" }]);
  const future = new Date(Date.now() + 3600_000).toISOString();
  const r = filterUnhandled(acct, [{ message_id: "b2", thread_id: "tb", date: future }]);
  expect(r.fresh).toHaveLength(1);
  expect(r.fresh[0].resurfaced).toBe(true);
});

test("re-marking updates without a duplicate row", () => {
  markHandled([{ account: acct, message_id: "c1", decision: "noise" }]);
  const before = count();
  markHandled([{ account: acct, message_id: "c1", decision: "task" }]);
  expect(count()).toBe(before);
  const row = db.prepare(`SELECT decision FROM mail_handled WHERE account = ? AND message_id = 'c1'`).get(acct) as { decision: string };
  expect(row.decision).toBe("task");
});

test("handledCounts reports per-decision counts", () => {
  const base = handledCounts();
  markHandled([
    { account: acct, message_id: "d1", decision: "tracker" },
    { account: acct, message_id: "d2", decision: "tracker" },
  ]);
  const after = handledCounts();
  expect(after.by_decision.tracker - (base.by_decision.tracker || 0)).toBe(2);
  expect(after.handled_total - base.handled_total).toBe(2);
});

test("label failure still records the ledger entry", async () => {
  const r = await markHandledAndLabel([{ account: acct, message_id: "e1", decision: "noise" }], async () => {
    throw new Error("gmail down");
  });
  expect(r).toEqual({ recorded: 1, label_applied: false });
  expect(filterUnhandled(acct, [{ message_id: "e1" }]).skipped).toHaveLength(1);
});
