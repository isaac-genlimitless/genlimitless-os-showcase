import test from "node:test";
import assert from "node:assert/strict";
import { buildReconcilePrompt, closedBetween, buildChatSummary } from "./task-reconcile";
import type { Task } from "./tasks";

const t = (id: number, over: Partial<Task> = {}): Task => ({
  id, title: `Task ${id}`, notes: null, category: null, status: "open", priority: "normal",
  due_date: null, created_by: "owner", created_at: "2026-10-01 10:00:00", updated_at: "2026-10-01 10:00:00", completed_at: null, ...over,
});

test("prompt lists every task id and demands evidence, no sending", () => {
  const p = buildReconcilePrompt([t(7, { title: "Mail in phone for CarrierCo" }), t(9, { title: "Create the scavenger hunt" })]);
  assert.match(p, /Task 7 .*Mail in phone for CarrierCo/);
  assert.match(p, /Task 9 .*scavenger hunt/);
  assert.match(p, /ONLY with update_task status "done"/);
  assert.match(p, /Never send/);
});

test("closedBetween only counts tasks that were open and are now done", () => {
  const before = [t(1), t(2), t(3)];
  const after = [t(1, { status: "done" }), t(2), null];
  assert.deepEqual(closedBetween(before, after).map((x) => x.id), [1]);
});

test("a task that was already done is never reported as closed", () => {
  assert.deepEqual(closedBetween([t(1)], [t(2, { status: "done" })]), []);
});

test("summary shows the auto-close evidence and the remaining count", () => {
  const closed = [t(7, { title: "Mail in phone", status: "done", notes: "Auto-closed 2026-11-04: CarrierCo emailed that they received the phone" })];
  const s = buildChatSummary(closed, 5, "");
  assert.match(s, /closed 1 finished task/);
  assert.match(s, /Mail in phone: CarrierCo emailed that they received the phone/);
  assert.match(buildChatSummary([], 5, ""), /nothing new to close.*5 still open/);
});
