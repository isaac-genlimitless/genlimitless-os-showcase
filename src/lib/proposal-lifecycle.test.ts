import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";

// Sandbox DB: set before db.ts is loaded. The live database is never touched. Nothing here sends anything.
process.env.GENLIMITLESS_DATA_DIR = fs.mkdtempSync(os.tmpdir() + "/decisions-test-");

const load = async () => {
  const { default: db } = await import("./db");
  await import("./email-drafts"); // creates email_drafts
  const life = await import("./proposal-lifecycle");
  return { db, ...life };
};

const TABLES = ["email_drafts", "text_drafts", "schedule_items", "inbound_emails"];
const counts = (db: any) => TABLES.map((t) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c);
const lifecycleLogs = (db: any) => (db.prepare(`SELECT COUNT(*) c FROM agent_activity WHERE trigger='proposal_lifecycle'`).get() as any).c as number;

async function fresh() {
  const m = await load();
  // Reset the throwaway DB only (test setup, never the live one).
  for (const t of [...TABLES, "agent_activity"]) m.db.exec(`DELETE FROM ${t}`);
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
  const block = (status: string, endOffsetMs: number, title = "Block") =>
    Number(m.db.prepare(`INSERT INTO schedule_items (date, title, start, end, status) VALUES ('2000-01-01', ?, ?, ?, ?)`).run(title, iso(endOffsetMs - 3600000), iso(endOffsetMs), status).lastInsertRowid);
  const email = (o: { to?: string; subject?: string; status?: string; by?: string; created?: string; reply?: boolean } = {}) =>
    Number(m.db.prepare(`INSERT INTO email_drafts (account, to_addr, subject, body, created_by, status, in_reply_to, created_at, updated_at, sent_at) VALUES ('a', ?, ?, 'b', ?, ?, ?, ?, ?, ?)`)
      .run(o.to || "x@example.com", o.subject ?? "Hello", o.by || "marcus", o.status || "pending_approval", o.reply ? "<m@id>" : null,
        o.created || "2030-01-01 10:00:00", o.created || "2030-01-01 10:00:00", o.status === "sent" ? o.created || "2030-01-01 10:00:00" : null).lastInsertRowid);
  const inbound = (from: string, subject: string, at: string) =>
    Number(m.db.prepare(`INSERT INTO inbound_emails (account, message_id, from_address, subject, created_at) VALUES ('a', ?, ?, ?, ?)`).run("m" + Math.random(), from, subject, at).lastInsertRowid);
  const text = (handle: string, status = "pending_approval", reason: string | null = "orig reason") =>
    Number(m.db.prepare(`INSERT INTO text_drafts (to_handle, text, reason, status) VALUES (?, 't', ?, ?)`).run(handle, reason, status).lastInsertRowid);
  const row = (table: string, id: number) => m.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as any;
  return { ...m, block, email, inbound, text, row };
}

test("1 expirePastCalendar expires only ended proposed blocks", async () => {
  const t = await fresh();
  const past = t.block("proposed", -86400000);
  const later = t.block("proposed", 3 * 3600000);
  const approved = t.block("approved", -86400000);
  const before = counts(t.db);
  assert.equal(t.expirePastCalendar(), 1);
  assert.equal(t.row("schedule_items", past).status, "expired");
  assert.equal(t.row("schedule_items", later).status, "proposed");
  assert.equal(t.row("schedule_items", approved).status, "approved");
  assert.deepEqual(counts(t.db), before);
  assert.ok(lifecycleLogs(t.db) >= 1);
});

test("2 supersedeStaleEmails: inbound newer than a reply draft supersedes it", async () => {
  const t = await fresh();
  const stale = t.email({ to: "X@Example.com", subject: "Re: Hello", reply: true, created: "2030-01-01 10:00:00" });
  const fine = t.email({ to: "y@example.com", subject: "Other", created: "2030-01-01 10:00:00" });
  const sent = t.email({ to: "x@example.com", subject: "Hello", status: "sent", created: "2029-12-01 10:00:00" });
  t.inbound("X <x@example.com>", "Hello", "2030-01-01 11:00:00");
  const before = counts(t.db);
  assert.equal(t.supersedeStaleEmails(), 1);
  const r = t.row("email_drafts", stale);
  assert.equal(r.status, "superseded");
  assert.match(r.error, /^Superseded: /);
  assert.equal(t.row("email_drafts", fine).status, "pending_approval");
  assert.equal(t.row("email_drafts", sent).status, "sent");
  assert.deepEqual(counts(t.db), before);
  assert.ok(lifecycleLogs(t.db) >= 1);
});

test("3 supersedeStaleTexts: later sent text to same handle supersedes, reason kept", async () => {
  const t = await fresh();
  const old = t.text("+1 (801) 555-0100");
  const other = t.text("+1 (801) 555-0199");
  t.text("8015550100", "sent");
  const before = counts(t.db);
  assert.equal(t.supersedeStaleTexts(), 1);
  const r = t.row("text_drafts", old);
  assert.equal(r.status, "superseded");
  assert.ok(r.reason.startsWith("orig reason"));
  assert.match(r.reason, / \[Superseded: .+\]$/);
  assert.equal(t.row("text_drafts", other).status, "pending_approval");
  assert.deepEqual(counts(t.db), before);
  assert.ok(lifecycleLogs(t.db) >= 1);
});

test("4 sweepProposals never throws when a query fails", async () => {
  const t = await fresh();
  t.block("proposed", -86400000);
  const err = console.error;
  console.error = () => {};
  t.db.exec(`ALTER TABLE schedule_items RENAME COLUMN end TO end_x`);
  try {
    const out = t.sweepProposals();
    assert.deepEqual(Object.keys(out).sort(), ["emails", "expired", "texts"]);
    assert.equal(out.expired, 0);
  } finally {
    t.db.exec(`ALTER TABLE schedule_items RENAME COLUMN end_x TO end`);
    console.error = err;
  }
  assert.equal(t.sweepProposals().expired, 1);
});

test("5 supersedeProposal permissions", async () => {
  const t = await fresh();
  const e1 = t.email({ by: "marcus", subject: "A" });
  const e2 = t.email({ by: "chief", subject: "B", to: "z@example.com" });
  const e3 = t.email({ by: "marcus", subject: "C", to: "q@example.com" });
  const done = t.email({ by: "chief", status: "sent", to: "w@example.com" });
  const tx = t.text("+18015550111");
  const cal = t.block("proposed", 3 * 3600000);
  const before = counts(t.db);

  assert.throws(() => t.supersedeProposal({ kind: "email", id: e1, reason: "no", by: "marcus" }), /reason is required/);
  assert.throws(() => t.supersedeProposal({ kind: "email", id: 99999, reason: "not found id", by: "marcus" }), /not found/);
  assert.throws(() => t.supersedeProposal({ kind: "email", id: done, reason: "already sent", by: "chief" }), /only pending/);
  assert.throws(() => t.supersedeProposal({ kind: "email", id: e1, reason: "not mine", by: "chief" }), /marcus/);
  assert.equal(t.row("email_drafts", e1).status, "pending_approval");

  assert.equal(t.supersedeProposal({ kind: "email", id: e2, reason: "my own draft", by: "chief" }).status, "superseded");
  assert.equal(t.row("email_drafts", e2).error, "Superseded by chief: my own draft");
  assert.equal(t.supersedeProposal({ kind: "email", id: e3, reason: "cos override", by: "chief_of_staff" }).status, "superseded");

  assert.throws(() => t.supersedeProposal({ kind: "text", id: tx, reason: "not allowed", by: "chief" }), /do not record their author/);
  assert.throws(() => t.supersedeProposal({ kind: "calendar", id: cal, reason: "not allowed", by: "chief" }), /do not record their author/);

  t.supersedeProposal({ kind: "text", id: tx, reason: "replaced text", by: "chief_of_staff" });
  t.supersedeProposal({ kind: "calendar", id: cal, reason: "replaced block", by: "chief_of_staff" });
  assert.equal(t.row("text_drafts", tx).status, "superseded");
  assert.match(t.row("text_drafts", tx).reason, /replaced text/);
  assert.equal(t.row("schedule_items", cal).status, "superseded");
  assert.match(t.row("schedule_items", cal).reason, /replaced block/);

  assert.deepEqual(counts(t.db), before); // 6: no deletes
  assert.equal(lifecycleLogs(t.db), 4); // 7: one activity row per successful change
});

test("8 listDecisions shows neither an ended block nor a stale email draft", async () => {
  const t = await fresh();
  const blockId = t.block("proposed", -86400000);
  const draftId = t.email({ to: "x@example.com", subject: "Re: Hello", reply: true, created: "2030-01-01 10:00:00" });
  t.inbound("x@example.com", "Hello", "2030-01-01 11:00:00");
  const { listDecisions } = await import("./decisions");
  const keys = listDecisions().items.map((i: any) => i.key);
  assert.ok(!keys.some((k: string) => k.endsWith(`:${draftId}`) && k.startsWith("email")));
  assert.ok(!keys.some((k: string) => k.includes("schedule") && k.endsWith(`:${blockId}`)));
  assert.equal(t.row("email_drafts", draftId).status, "superseded");
  assert.equal(t.row("schedule_items", blockId).status, "expired");
});
