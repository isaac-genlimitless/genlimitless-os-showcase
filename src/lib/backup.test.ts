// Backup folder is created on demand; data dir prefers the shared live DB. No sends, no agents.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

test("backupDatabase creates a missing backups folder and returns an existing file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-"));
  process.env.GENLIMITLESS_DATA_DIR = dir;
  assert.ok(!fs.existsSync(path.join(dir, "backups")));
  const { backupDatabase } = await import("./backup");
  const res = await backupDatabase();
  assert.ok(res, "backup should succeed");
  assert.ok(fs.existsSync(res!.path));
  assert.ok(res!.path.startsWith(path.join(dir, "backups")));
});

test("pruneOldBackups keeps only the newest 3 and touches nothing else", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bkprune-"));
  process.env.GENLIMITLESS_DATA_DIR = tmp;
  const { pruneOldBackups } = await import("./backup");
  const { DATA_DIR } = await import("./data-dir"); // module may be cached from an earlier test
  const bdir = path.join(DATA_DIR, "backups");
  fs.mkdirSync(bdir, { recursive: true });
  for (const f of fs.readdirSync(bdir)) fs.unlinkSync(path.join(bdir, f));
  for (let d = 20; d <= 25; d++) fs.writeFileSync(path.join(bdir, `genlimitless-2026-10-${d}.db`), "x");
  fs.writeFileSync(path.join(bdir, "other.db"), "x");
  const live = path.join(DATA_DIR, "genlimitless.db");
  const liveExisted = fs.existsSync(live);
  if (!liveExisted) fs.writeFileSync(live, "live");
  pruneOldBackups();
  assert.deepEqual(
    fs.readdirSync(bdir).sort(),
    ["genlimitless-2026-10-23.db", "genlimitless-2026-10-24.db", "genlimitless-2026-10-25.db", "other.db"],
  );
  assert.ok(fs.existsSync(live));
  if (!liveExisted) fs.unlinkSync(live);
});

test("resolveDataDir selection", async () => {
  const { resolveDataDir } = await import("./data-dir");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glos-"));
  const cwd = "/tmp/some-release";
  // no shared db yet -> cwd/data
  assert.equal(resolveDataDir({ GLOS_ROOT: root } as any, cwd), path.join(cwd, "data"));
  fs.mkdirSync(path.join(root, "shared", "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "shared", "data", "genlimitless.db"), "");
  assert.equal(resolveDataDir({ GLOS_ROOT: root } as any, cwd), path.join(root, "shared", "data"));
  // explicit env wins
  assert.equal(resolveDataDir({ GLOS_ROOT: root, GENLIMITLESS_DATA_DIR: "/tmp/x" } as any, cwd), path.resolve("/tmp/x"));
});
