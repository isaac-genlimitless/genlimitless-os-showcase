import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Point the DB at a throwaway dir before db.ts is loaded. No agent run, no sending.
process.env.GENLIMITLESS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "genlimitless-e2e-data-"));

test("runDueMissions creates the creations tables instead of throwing", async () => {
  const { default: db } = await import("../db");
  const { runDueMissions } = await import("./missions");
  const has = () =>
    !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='creation_missions'").get();
  db.exec("DROP TABLE IF EXISTS creation_missions");
  assert.equal(has(), false);
  const result = await runDueMissions();
  assert.equal(result, null);
  assert.equal(has(), true);
});
