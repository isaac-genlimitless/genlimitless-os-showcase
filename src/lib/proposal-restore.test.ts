import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Throwaway DB, set before db.ts loads. Never sends anything.
process.env.GENLIMITLESS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "genlimitless-restore-"));

async function setup() {
  const { default: db } = await import("./db");
  await import("./email-drafts"); // creates email_drafts
  const mod = await import("./proposal-restore");
  return { db, ...mod };
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const dateKey = (offsetMs: number) => iso(offsetMs).slice(0, 10);
const email = (db: any, to: string, subject: string, status: string, createdAt = "datetime('now')", error: string | null = null) =>
  Number(db.prepare(`INSERT INTO email_drafts (account, to_addr, subject, body, created_by, status, error, created_at) VALUES ('a', ?, ?, 'b', 'x', ?, ?, ${createdAt})`).run(to, subject, status, error).lastInsertRowid);
const text = (db: any, handle: string, status: string, reason = "why", createdAt = "datetime('now')") =>
  Number(db.prepare(`INSERT INTO text_drafts (to_handle, text, reason, status, created_at) VALUES (?, 't', ?, ?, ${createdAt})`).run(handle, reason, status).lastInsertRowid);
const cal = (db: any, status: string, offsetMs: number, createdAt = "datetime('now')") =>
  Number(db.prepare(`INSERT INTO schedule_items (date, title, start, end, status, created_at) VALUES (?, 'Block', ?, ?, ?, ${createdAt})`).run(dateKey(offsetMs), iso(offsetMs - 3600_000), iso(offsetMs), status).lastInsertRowid);
const count = (db: any) => ["email_drafts", "text_drafts", "schedule_items"].map((t) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c).join(",");
const status = (db: any, table: string, id: number) => (db.prepare(`SELECT status FROM ${table} WHERE id=?`).get(id) as any).status;

test("listRetired returns retired rows only, within 14 days", async () => {
  const { db, listRetired } = await setup();
  const e = email(db, "a@x.com", "S1", "superseded", "datetime('now')", "Superseded: newer draft");
  const t = text(db, "+18015550001", "superseded", "r [Superseded: newer text]");
  const c1 = cal(db, "expired", -3600_000);
  const c2 = cal(db, "superseded", 3600_000);
  email(db, "b@x.com", "P", "pending_approval");
  email(db, "c@x.com", "Sent", "sent");
  email(db, "d@x.com", "Rej", "cancelled");
  const old = email(db, "old@x.com", "Old", "superseded", "datetime('now','-30 days')");
  const got = listRetired();
  const keys = got.map((i) => `${i.kind}:${i.id}`);
  for (const k of [`email:${e}`, `text:${t}`, `calendar:${c1}`, `calendar:${c2}`]) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes(`email:${old}`));
  assert.equal(got.length, 4);
  assert.match(got.find((i) => i.kind === "email")!.why, /^Superseded: newer draft/);
  assert.match(got.find((i) => i.kind === "text")!.why, /newer text/);
  assert.equal(got.find((i) => i.id === c1 && i.kind === "calendar")!.why, "Its end time passed");
});

test("restore email/text/calendar flips status, logs activity, clears error, deletes nothing", async () => {
  const { db, restoreProposal } = await setup();
  const e = email(db, "solo@x.com", "Unique", "superseded", "datetime('now')", "Superseded: x");
  const t = text(db, "+18015559999", "superseded");
  const c = cal(db, "expired", 3600_000);
  const before = count(db);
  const acts = (db.prepare(`SELECT COUNT(*) c FROM agent_activity WHERE trigger='proposal_lifecycle'`).get() as any).c;
  assert.equal(restoreProposal({ kind: "email", id: e, by: "owner" }).status, "pending_approval");
  restoreProposal({ kind: "text", id: t, by: "owner" });
  assert.equal(restoreProposal({ kind: "calendar", id: c, by: "owner" }).status, "proposed");
  assert.equal(status(db, "email_drafts", e), "pending_approval");
  assert.equal(status(db, "text_drafts", t), "pending_approval");
  assert.equal(status(db, "schedule_items", c), "proposed");
  assert.equal((db.prepare(`SELECT error FROM email_drafts WHERE id=?`).get(e) as any).error, null);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM agent_activity WHERE trigger='proposal_lifecycle'`).get() as any).c, acts + 3);
  assert.equal(count(db), before);
});

test("restore refuses a past calendar block", async () => {
  const { db, restoreProposal } = await setup();
  const c = cal(db, "expired", -3600_000);
  assert.throws(() => restoreProposal({ kind: "calendar", id: c, by: "owner" }), /end time/);
  assert.equal(status(db, "schedule_items", c), "expired");
});

test("restore refuses a still-stale email and text", async () => {
  const { db, restoreProposal } = await setup();
  const e = email(db, "stale@x.com", "Re: Hello", "superseded", "datetime('now','-1 hour')", "Superseded: x");
  db.prepare(`INSERT INTO email_drafts (account, to_addr, subject, body, created_by, status, in_reply_to) VALUES ('a','stale@x.com','Re: Hello','b','x','pending_approval','<m>')`).run();
  assert.throws(() => restoreProposal({ kind: "email", id: e, by: "owner" }), /retired again/);
  assert.equal(status(db, "email_drafts", e), "superseded");
  const e2 = email(db, "inb@x.com", "Re: Q", "superseded", "datetime('now','-1 hour')", "Superseded: x");
  db.prepare(`UPDATE email_drafts SET in_reply_to='<z>' WHERE id=?`).run(e2);
  db.prepare(`INSERT INTO inbound_emails (account, message_id, from_address, subject) VALUES ('a','m1','inb@x.com','Re: Q')`).run();
  assert.throws(() => restoreProposal({ kind: "email", id: e2, by: "owner" }), /retired again/);
  const t = text(db, "+18015557777", "superseded");
  text(db, "+18015557777", "pending_approval");
  assert.throws(() => restoreProposal({ kind: "text", id: t, by: "owner" }), /retired again/);
  assert.equal(status(db, "text_drafts", t), "superseded");
});

test("restore refuses rows that are not retired and unknown kinds", async () => {
  const { db, restoreProposal } = await setup();
  const sent = email(db, "s@x.com", "S", "sent");
  const pend = text(db, "+18015558888", "pending_approval");
  const before = count(db);
  assert.throws(() => restoreProposal({ kind: "email", id: sent, by: "owner" }), /not retired/);
  assert.throws(() => restoreProposal({ kind: "text", id: pend, by: "owner" }), /not retired/);
  assert.throws(() => restoreProposal({ kind: "bogus", id: 1, by: "owner" }), /Unknown kind/);
  assert.equal(status(db, "email_drafts", sent), "sent");
  assert.equal(count(db), before);
});
