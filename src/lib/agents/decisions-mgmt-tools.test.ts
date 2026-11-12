import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";

// Sandbox DB: set before db.ts is loaded. Nothing here sends anything.
process.env.GENLIMITLESS_DATA_DIR = fs.mkdtempSync(os.tmpdir() + "/decisions-mgmt-test-");

async function setup() {
  const { default: db } = await import("../db");
  await import("../email-drafts");
  const { decisionsMgmtTools } = await import("./decisions-mgmt-tools");
  const h = (name: string) => (decisionsMgmtTools.find((t: any) => t.name === name) as any).handler as (a: any, e?: any) => Promise<any>;
  const fut = (days: number, hours = 0) => new Date(Date.now() + days * 86400000 + hours * 3600000).toISOString();
  const dateKey = (iso: string) => iso.slice(0, 10);
  const block = (status: string, title = "Focus", startIso = fut(2), endIso = fut(2, 1)) =>
    Number(db.prepare(`INSERT INTO schedule_items (date, title, start, end, status) VALUES (?,?,?,?,?)`).run(dateKey(startIso), title, startIso, endIso, status).lastInsertRowid);
  const count = () =>
    ["email_drafts", "text_drafts", "schedule_items"].reduce((n, t) => n + (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c, 0);
  return { db, h, block, fut, count };
}

test("list_pending_decisions returns pending items and retired on request", async () => {
  const t = await setup();
  t.db.prepare(`INSERT INTO email_drafts (account, to_addr, subject, body, created_by) VALUES ('a','pend@example.com','S','b','chief')`).run();
  t.db.prepare(`INSERT INTO email_drafts (account, to_addr, subject, body, created_by, status) VALUES ('a','old@example.com','S2','b','chief','superseded')`).run();
  t.db.prepare(`INSERT INTO text_drafts (to_handle, text) VALUES ('+18015550101','hi')`).run();
  const id = t.block("proposed", "ListMe");
  const res = await t.h("list_pending_decisions")({}, {});
  assert.notEqual(res.isError, true);
  const out = JSON.parse(res.content[0].text);
  const kinds = out.items.map((i: any) => i.kind);
  assert.ok(kinds.includes("email_draft") && kinds.includes("text_draft") && kinds.includes("schedule_item"));
  assert.ok(out.items.some((i: any) => i.key === `schedule_item:${id}`));
  assert.equal(out.retired, undefined);
  const withR = JSON.parse((await t.h("list_pending_decisions")({ include_retired: true }, {})).content[0].text);
  assert.ok(withR.retired.some((r: any) => r.kind === "email"));
});

test("edit_calendar_proposal edits proposed blocks and rejects bad input", async () => {
  const t = await setup();
  const edit = t.h("edit_calendar_proposal");
  const before = t.count();
  const id = t.block("proposed");
  const s = t.fut(3), e = t.fut(3, 2);
  const ok = await edit({ id, title: "New", start: s, end: e }, {});
  assert.notEqual(ok.isError, true);
  const row = JSON.parse(ok.content[0].text);
  assert.equal(row.title, "New");
  assert.equal(row.start, s);
  assert.equal(row.end, e);
  assert.equal((await edit({ id, start: t.fut(3, 5) }, {})).isError, true); // end <= start
  assert.equal((await edit({ id }, {})).isError, true); // empty
  assert.equal((await edit({ id, start: "nonsense" }, {})).isError, true);
  assert.equal((await edit({ id: t.block("approved"), title: "x" }, {})).isError, true);
  assert.equal((await edit({ id: t.block("expired"), title: "x" }, {})).isError, true);
  assert.equal(t.count(), before + 3);
});

test("restore_proposal: CoS only, refuses ended blocks, never deletes", async () => {
  const t = await setup();
  const restore = t.h("restore_proposal");
  const id = t.block("superseded");
  const before = t.count();
  const denied = await restore({ kind: "calendar", id, reason: "need it back", as_agent: "chief" }, {});
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /Chief of Staff/);
  const ok = await restore({ kind: "calendar", id, reason: "need it back", as_agent: "chief_of_staff" }, {});
  assert.notEqual(ok.isError, true);
  assert.equal((t.db.prepare(`SELECT status FROM schedule_items WHERE id=?`).get(id) as any).status, "proposed");
  const past = t.block("expired", "Past", t.fut(-3, 0), t.fut(-3, 1));
  const refused = await restore({ kind: "calendar", id: past, reason: "need it back", as_agent: "chief_of_staff" }, {});
  assert.equal(refused.isError, true);
  assert.equal((t.db.prepare(`SELECT status FROM schedule_items WHERE id=?`).get(past) as any).status, "expired");
  assert.equal(t.count(), before + 1);
});

test("only the Chief of Staff gets the tools", async () => {
  const { permsFor } = await import("./runtime");
  const names = ["list_pending_decisions", "edit_calendar_proposal", "restore_proposal"];
  const cos = permsFor({ slug: "chief_of_staff" } as any).mcp;
  const custom = permsFor({ slug: "custom_helper", tools: "[]" } as any).mcp;
  for (const n of names) {
    assert.ok(cos.has(n), `cos missing ${n}`);
    assert.ok(!custom.has(n), `custom has ${n}`);
  }
});
