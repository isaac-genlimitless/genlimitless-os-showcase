// Unit test with a temp DB. Never sends anything, never triggers an agent.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { recoverPage399, recoverPage399Followup, RECOVERY_TITLE } from "./recover-page-399";

test("followup appends a 10/27 undo snapshot once and is unchanged on a second run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec399f-"));
  process.env.GENLIMITLESS_DATA_DIR = dir;
  const db = new Database(path.join(dir, "t.db"));
  db.exec(`
    CREATE TABLE docs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general', created_by TEXT NOT NULL DEFAULT 'owner', parent_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE undo_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT, tool TEXT NOT NULL,
      entity TEXT NOT NULL, entity_id TEXT, state TEXT NOT NULL DEFAULT 'recorded', before_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  db.prepare(`INSERT INTO docs (id, title, body) VALUES (399, 'Page', 'current')`).run();
  db.prepare(`INSERT INTO docs (id, title, body) VALUES (403, ?, 'intro')`).run(RECOVERY_TITLE);
  db.prepare(`INSERT INTO undo_actions (agent_slug, tool, entity, entity_id, before_json, created_at) VALUES ('coach','update_page','page','399',?,'2026-10-27 00:52:00')`).run(
    JSON.stringify({ body: "Our divine responsibilities\nOwner goals here" })
  );
  const before399 = db.prepare(`SELECT * FROM docs WHERE id=399`).get();
  const opts = { skipBackup: true, backupsDir: path.join(dir, "none") };

  const r1 = await recoverPage399Followup(db, opts);
  assert.equal(r1.appended, 1);
  const b1 = (db.prepare(`SELECT body FROM docs WHERE title=?`).get(RECOVERY_TITLE) as { body: string }).body;
  assert.ok(b1.includes("## Undo log #1"));
  assert.ok(b1.includes("Owner goals here"));

  const r2 = await recoverPage399Followup(db, opts);
  assert.equal(r2.appended, 0);
  const b2 = (db.prepare(`SELECT body FROM docs WHERE title=?`).get(RECOVERY_TITLE) as { body: string }).body;
  assert.equal(b2, b1);
  assert.deepEqual(db.prepare(`SELECT * FROM docs WHERE id=399`).get(), before399);
});

test("copies undo_actions bodies into a new page, leaves docs 399 unchanged, is idempotent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec399-"));
  process.env.GENLIMITLESS_DATA_DIR = dir;
  const db = new Database(path.join(dir, "t.db"));
  db.exec(`
    CREATE TABLE docs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general', created_by TEXT NOT NULL DEFAULT 'owner', parent_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE undo_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT, tool TEXT NOT NULL,
      entity TEXT NOT NULL, entity_id TEXT, state TEXT NOT NULL DEFAULT 'recorded', before_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  db.prepare(`INSERT INTO docs (id, title, body) VALUES (399, 'Page', 'current')`).run();
  db.prepare(`INSERT INTO undo_actions (agent_slug, tool, entity, entity_id, before_json) VALUES ('x','update_page','page','399',?)`).run(
    JSON.stringify({ body: "Producers, not consumers" })
  );
  const before = db.prepare(`SELECT * FROM docs WHERE id=399`).get();

  const r = await recoverPage399(db, { skipBackup: true, backupsDir: path.join(dir, "none") });
  assert.equal(r.created, true);
  const rec = db.prepare(`SELECT body FROM docs WHERE title=?`).get(RECOVERY_TITLE) as { body: string };
  assert.ok(rec.body.includes("Producers, not consumers"));
  assert.deepEqual(db.prepare(`SELECT * FROM docs WHERE id=399`).get(), before);

  const again = await recoverPage399(db, { skipBackup: true });
  assert.equal(again.created, false);
});
