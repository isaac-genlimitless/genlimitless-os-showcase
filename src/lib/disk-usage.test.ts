// Unit test for the read-only disk usage listing. Temp dir only; asserts nothing is changed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { listDiskUsage } from "./disk-usage";

test("lists every entry with size/date/tags and changes nothing", async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "du-")), "os");
  const rel = path.join(root, "releases");
  const names = ["a00000000001", "a00000000002", "a00000000003", "a00000000004", "a00000000005"];
  const base = Date.now() / 1000 - 10000;
  names.forEach((n, i) => {
    fs.mkdirSync(path.join(rel, n), { recursive: true });
    fs.writeFileSync(path.join(rel, n, "f"), "x".repeat(5000));
    fs.utimesSync(path.join(rel, n), base + i * 100, base + i * 100);
  });
  fs.symlinkSync(path.join(rel, names[0]), path.join(root, "current"));
  fs.symlinkSync(path.join(rel, names[1]), path.join(root, "previous"));
  fs.mkdirSync(path.join(root, "backups"));
  const bk = ["pre-deploy-20261001T000000Z-a00000000001.db", "pre-deploy-20261002T000000Z-a00000000002.db", "pre-deploy-20261003T000000Z-a00000000005.db"];
  bk.forEach((b, i) => { const f = path.join(root, "backups", b); fs.writeFileSync(f, "db".repeat(4000)); fs.utimesSync(f, base + i * 100, base + i * 100); });
  const snap = () => JSON.stringify(fs.readdirSync(rel)) + JSON.stringify(fs.readdirSync(path.join(root, "backups")));
  const before = snap();

  const u = await listDiskUsage(root, path.join(rel, names[0]));
  assert.equal(u.runningRelease, names[0]);
  assert.equal(u.currentRelease, names[0]);
  assert.equal(u.previousRelease, names[1]);
  const r = u.folders.find((f) => f.folder === "releases")!;
  assert.equal(r.entryCount, 5);
  assert.ok(r.entries.every((e) => e.bytes! > 0 && e.modified));
  assert.ok(r.entries.find((e) => e.name === names[0])!.tags.includes("running"));
  assert.ok(r.entries.find((e) => e.name === names[1])!.tags.includes("previous"));
  assert.ok(r.entries.find((e) => e.name === names[4])!.tags.includes("newest 3 (auto-cleanup keeps)"));
  assert.ok(r.entries.find((e) => e.name === names[2])!.tags.includes("newest 3 (auto-cleanup keeps)"));
  const b = u.folders.find((f) => f.folder === "backups")!;
  assert.equal(b.entries[0].name, bk[2]);
  assert.ok(b.entries[0].tags.includes("newest pre-deploy backup"));
  assert.ok(b.entries.find((e) => e.name === bk[0])!.tags.includes("taken deploying current release"));
  assert.equal(u.folders.find((f) => f.folder === "work")!.exists, false);
  assert.equal(snap(), before);
});
