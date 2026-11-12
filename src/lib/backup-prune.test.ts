// Unit test for pre-deploy backup pruning using a temp dir. No database, no network, never sends.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { pruneDeployBackups, type BackupPruneDeps } from "./backup-prune";

const store = new Map<string, string>();
const deps: BackupPruneDeps = { logIssue: () => {}, getState: (k) => store.get(k) ?? null, setState: (k, v) => void store.set(k, v) };
const idle = () => ({ state: "idle" });
const shas = ["b00000000001", "b00000000002", "b00000000003", "b00000000004", "b00000000005", "b00000000006"];
const snap = (i: number) => `pre-deploy-2026100${i + 1}T120000Z-${shas[i]}.db`;

function setup(count = 6, previousIdx: number | null = null) {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bkp-")), "os");
  const bk = path.join(root, "backups");
  const rel = path.join(root, "releases");
  fs.mkdirSync(bk, { recursive: true });
  fs.mkdirSync(path.join(rel, shas[count - 1]), { recursive: true });
  fs.symlinkSync(path.join(rel, shas[count - 1]), path.join(root, "current"));
  if (previousIdx != null) {
    fs.mkdirSync(path.join(rel, shas[previousIdx]), { recursive: true });
    fs.symlinkSync(path.join(rel, shas[previousIdx]), path.join(root, "previous"));
  }
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(bk, snap(i)), "x".repeat(1000 * (i + 1)));
  fs.writeFileSync(path.join(bk, "manual-copy.db"), "keep");
  fs.mkdirSync(path.join(bk, "pre-deploy-20260101T000000Z-aaaaaaaaaaaa.db"));
  const outside = path.join(root, "outside.db");
  fs.writeFileSync(outside, "keep");
  fs.symlinkSync(outside, path.join(bk, "pre-deploy-20250101T000000Z-cccccccccccc.db"));
  return { root, bk, outside };
}

test("keeps newest 3, removes older snapshots, ignores everything else", () => {
  const { root, bk, outside } = setup();
  const r = pruneDeployBackups(root, idle, deps);
  assert.deepEqual(r.removed.map((x) => x.name).sort(), [snap(0), snap(1), snap(2)]);
  assert.equal(r.freedBytes, 1000 + 2000 + 3000);
  for (const i of [3, 4, 5]) assert.ok(fs.existsSync(path.join(bk, snap(i))));
  assert.ok(fs.existsSync(path.join(bk, "manual-copy.db")));
  assert.ok(fs.statSync(path.join(bk, "pre-deploy-20260101T000000Z-aaaaaaaaaaaa.db")).isDirectory());
  assert.ok(fs.lstatSync(path.join(bk, "pre-deploy-20250101T000000Z-cccccccccccc.db")).isSymbolicLink());
  assert.ok(fs.existsSync(outside));
  assert.equal(pruneDeployBackups(root, idle, deps).removed.length, 0);
});

test("snapshot for the previous release is kept even if old", () => {
  const { root, bk } = setup(6, 0);
  const r = pruneDeployBackups(root, idle, deps);
  assert.deepEqual(r.removed.map((x) => x.name).sort(), [snap(1), snap(2)]);
  assert.ok(fs.existsSync(path.join(bk, snap(0))));
});

test("3 or fewer snapshots removes nothing; the newest is never removed", () => {
  const { root, bk } = setup(3);
  assert.equal(pruneDeployBackups(root, idle, deps).removed.length, 0);
  assert.ok(fs.existsSync(path.join(bk, snap(2))));
});

test("deploy running removes nothing", () => {
  const { root, bk } = setup();
  const r = pruneDeployBackups(root, () => ({ state: "running" }), deps);
  assert.equal(r.skippedReason, "deploy running");
  assert.equal(r.removed.length, 0);
  assert.ok(fs.existsSync(path.join(bk, snap(0))));
});

test("missing backups folder removes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bkp-none-"));
  assert.equal(pruneDeployBackups(root, idle, deps).skippedReason, "backups folder not found");
});
