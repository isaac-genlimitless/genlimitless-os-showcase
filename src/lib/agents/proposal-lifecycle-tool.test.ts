import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";

// Sandbox DB: set before db.ts is loaded. Nothing here sends anything.
process.env.GENLIMITLESS_DATA_DIR = fs.mkdtempSync(os.tmpdir() + "/decisions-test-");

async function setup() {
  const { default: db } = await import("../db");
  await import("../email-drafts");
  const { proposalLifecycleTools } = await import("./proposal-lifecycle-tool");
  const handler = (proposalLifecycleTools[0] as any).handler as (a: any, e?: any) => Promise<any>;
  const email = (by: string) =>
    Number(db.prepare(`INSERT INTO email_drafts (account, to_addr, subject, body, created_by) VALUES ('a','x@example.com','S','b',?)`).run(by).lastInsertRowid);
  const text = () => Number(db.prepare(`INSERT INTO text_drafts (to_handle, text) VALUES ('+18015550100','t')`).run().lastInsertRowid);
  return { db, handler, email, text };
}

test("success returns JSON with status superseded", async () => {
  const t = await setup();
  const id = t.email("chief");
  const res = await t.handler({ kind: "email", id, reason: "replaced by better", as_agent: "chief" }, {});
  assert.notEqual(res.isError, true);
  assert.equal(JSON.parse(res.content[0].text).status, "superseded");
});

test("rule violation returns isError with the message", async () => {
  const t = await setup();
  const id = t.email("marcus");
  const res = await t.handler({ kind: "email", id, reason: "not my draft", as_agent: "chief" }, {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /marcus/);
});

test("as_agent omitted falls back to 'agent' and is refused for text and calendar", async () => {
  const t = await setup();
  const res = await t.handler({ kind: "text", id: t.text(), reason: "no author given" }, {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /do not record their author/);
  const cal = await t.handler({ kind: "calendar", id: 1, reason: "no author given" }, {});
  assert.equal(cal.isError, true);
  assert.match(cal.content[0].text, /do not record their author/);
});
