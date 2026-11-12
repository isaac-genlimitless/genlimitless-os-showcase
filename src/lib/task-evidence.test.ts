import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";

// Isolated temp DB, set before db.ts loads. No network, model or send.
process.env.GENLIMITLESS_DATA_DIR = fs.mkdtempSync(os.tmpdir() + "/task-evidence-test-");

const load = async () => {
  const { default: db } = await import("./db");
  const tasks = await import("./tasks");
  const ev = await import("./task-evidence");
  return { db: db as any, tasks, ev };
};

const FUTURE = "2099-01-01T00:00:00Z";
const PAST = "2000-01-01T00:00:00Z";
const EXCERPT = "Bowflex is picked up";
const PACK = "Owner: hey mom,   the BOWFLEX is picked up today";

async function mk(title = "Pick up Bowflex") {
  const m = await load();
  const t = m.tasks.createTask({ title });
  const input = (o: any = {}) => ({ task_id: t.id, verdict: "done", source: "text_sent", source_ref: "msg-1", person: "Mom", excerpt: EXCERPT, confidence: "high", evidence_at: FUTURE, ...o });
  return { ...m, t, input };
}

test("1 high + verbatim + after creation auto-closes", async () => {
  const { ev, tasks, t, input } = await mk();
  const r = ev.recordEvidence(input(), "tester", { pack: PACK });
  assert.equal(r.outcome, "auto_closed");
  const got = tasks.getTask(t.id)!;
  assert.equal(got.status, "done");
  assert.match(got.notes!, /Auto-closed/);
  assert.match(got.notes!, /text_sent/);
  assert.match(got.notes!, /msg-1/);
  assert.match(got.notes!, /Bowflex is picked up/);
  assert.equal(ev.listEvidence({ task_id: t.id })[0].resolution, "auto_closed");
});

test("2 excerpt not in pack flags", async () => {
  const { ev, tasks, t, input } = await mk();
  assert.equal(ev.recordEvidence(input(), "tester", { pack: "nothing relevant here" }).outcome, "flagged");
  assert.equal(tasks.getTask(t.id)!.status, "open");
});

test("3 no pack flags", async () => {
  const { ev, tasks, t, input } = await mk();
  assert.equal(ev.recordEvidence(input(), "tester").outcome, "flagged");
  assert.equal(tasks.getTask(t.id)!.status, "open");
});

test("4 medium/low confidence flags", async () => {
  const { ev, tasks, t, input } = await mk();
  assert.equal(ev.recordEvidence(input({ confidence: "medium", source_ref: "a" }), "tester", { pack: PACK }).outcome, "flagged");
  assert.equal(ev.recordEvidence(input({ confidence: "low", source_ref: "b" }), "tester", { pack: PACK }).outcome, "flagged");
  assert.equal(tasks.getTask(t.id)!.status, "open");
});

test("5 evidence before task creation flags", async () => {
  const { ev, tasks, t, input } = await mk();
  assert.equal(ev.recordEvidence(input({ evidence_at: PAST }), "tester", { pack: PACK }).outcome, "flagged");
  assert.equal(tasks.getTask(t.id)!.status, "open");
});

test("6 missing ref or short excerpt is ignored", async () => {
  const { ev, tasks, t, input } = await mk();
  assert.equal(ev.recordEvidence(input({ source_ref: "" }), "tester", { pack: PACK }).outcome, "ignored");
  assert.equal(ev.recordEvidence(input({ excerpt: "short" }), "tester", { pack: "short" }).outcome, "ignored");
  assert.equal(tasks.getTask(t.id)!.status, "open");
  assert.equal(ev.listEvidence({ task_id: t.id }).length, 0);
});

test("7 done task is ignored", async () => {
  const { ev, tasks, t, input } = await mk();
  tasks.updateTask(t.id, { status: "done" });
  assert.equal(ev.recordEvidence(input(), "tester", { pack: PACK }).outcome, "ignored");
  assert.equal(ev.recordEvidence(input({ task_id: 999999 }), "tester", { pack: PACK }).outcome, "ignored");
});

test("8 dismissed ref ignored, new ref flagged", async () => {
  const { ev, t, input } = await mk();
  assert.equal(ev.recordEvidence(input({ confidence: "low" }), "tester").outcome, "flagged");
  ev.dismissLikelyDone(t.id, "owner");
  assert.equal(ev.recordEvidence(input({ confidence: "low" }), "tester").outcome, "ignored");
  assert.equal(ev.recordEvidence(input({ confidence: "low", source_ref: "msg-2" }), "tester").outcome, "flagged");
});

test("9 confirm marks done", async () => {
  const { ev, tasks, t, input } = await mk();
  ev.recordEvidence(input({ confidence: "medium" }), "tester");
  ev.confirmLikelyDone(t.id, "owner");
  const got = tasks.getTask(t.id)!;
  assert.equal(got.status, "done");
  assert.match(got.notes!, /Confirmed done/);
  assert.equal(ev.listEvidence({ task_id: t.id })[0].resolution, "confirmed");
});

test("10 revert reopens", async () => {
  const { ev, tasks, t, input } = await mk();
  ev.recordEvidence(input(), "tester", { pack: PACK });
  ev.revertAutoClose(t.id, "owner");
  const got = tasks.getTask(t.id)!;
  assert.equal(got.status, "open");
  assert.equal(got.completed_at, null);
  assert.equal(ev.listEvidence({ task_id: t.id })[0].resolution, "reverted");
});

test("11 bulkUpdateTasks", async () => {
  const { ev, tasks, t } = await mk();
  const t2 = tasks.createTask({ title: "Second" });
  const res = ev.bulkUpdateTasks([t.id, t.id, t2.id, 999999], { priority: "high", append_note: "bulk" }, "tester");
  assert.equal(res.length, 3);
  assert.equal(res.filter((r: any) => r.ok).length, 2);
  assert.match(tasks.getTask(t.id)!.notes!, /\[\d{4}-\d{2}-\d{2} tester\] bulk/);
  assert.equal(tasks.getTask(t.id)!.priority, "high");
  const bad = ev.bulkUpdateTasks([t.id], { status: "bogus" }, "tester");
  assert.equal(bad[0].ok, false);
  assert.throws(() => ev.bulkUpdateTasks(Array.from({ length: 51 }, (_, i) => i + 1), {}, "tester"));
  assert.ok(!Object.keys(ev).some((k) => /delete|remove/i.test(k)));
});

test("12 listLikelyDone only open + pending", async () => {
  const { ev, tasks, t, input } = await mk("Likely task unique");
  ev.recordEvidence(input({ confidence: "medium" }), "tester");
  assert.ok(ev.listLikelyDone().some((x: any) => x.task.id === t.id));
  ev.dismissLikelyDone(t.id, "owner");
  assert.ok(!ev.listLikelyDone().some((x: any) => x.task.id === t.id));
  ev.recordEvidence(input({ confidence: "medium", source_ref: "n" }), "tester");
  tasks.updateTask(t.id, { status: "done" });
  assert.ok(!ev.listLikelyDone().some((x: any) => x.task.id === t.id));
});

test("13 idempotent re-record", async () => {
  const { ev, t, input } = await mk();
  const a = ev.recordEvidence(input({ confidence: "medium" }), "tester");
  const b = ev.recordEvidence(input({ confidence: "medium" }), "tester");
  assert.equal(a.evidence_id, b.evidence_id);
  assert.equal(ev.listEvidence({ task_id: t.id }).length, 1);
});

test("14 table creation idempotent", async () => {
  const { db } = await load();
  db.exec(`CREATE TABLE IF NOT EXISTS task_evidence (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
  const cols = db.prepare(`PRAGMA table_info(task_evidence)`).all().map((c: any) => c.name);
  assert.ok(cols.includes("source_ref"));
});

test("15 listAutoClosed window", async () => {
  const { ev, db, t, input } = await mk();
  ev.recordEvidence(input(), "tester", { pack: PACK });
  assert.ok(ev.listAutoClosed(7).some((x: any) => x.task.id === t.id));
  db.prepare(`UPDATE task_evidence SET resolved_at = datetime('now','-30 days') WHERE task_id=?`).run(t.id);
  assert.ok(!ev.listAutoClosed(7).some((x: any) => x.task.id === t.id));
});

test("16 flagPossiblyDone does not close", async () => {
  const { ev, tasks, t } = await mk();
  const r = ev.flagPossiblyDone([t.id], { reason: "looks finished" }, "tester");
  assert.equal(r[0].ok, true);
  assert.equal(tasks.getTask(t.id)!.status, "open");
  assert.ok(ev.listLikelyDone().some((x: any) => x.task.id === t.id));
});

test("17 resolveEvidence bulk", async () => {
  const { ev, tasks, t, input } = await mk();
  const t2 = tasks.createTask({ title: "Another one" });
  ev.recordEvidence(input({ confidence: "medium" }), "tester");
  ev.recordEvidence({ ...input({ confidence: "medium" }), task_id: t2.id }, "tester");
  const ids = ev.listEvidence({ resolution: "pending" }).filter((e: any) => e.task_id === t.id || e.task_id === t2.id).map((e: any) => e.id);
  const res = ev.resolveEvidence(ids, "confirm", "owner");
  assert.ok(res.every((r: any) => r.ok));
  assert.equal(tasks.getTask(t.id)!.status, "done");
  assert.equal(tasks.getTask(t2.id)!.status, "done");
});
