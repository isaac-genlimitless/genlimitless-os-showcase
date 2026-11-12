// Unit test for old-release cleanup using a temp dir. No database, no network, never sends.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { runReleaseCleanup, type CleanupDeps } from "./release-cleanup";

const store = new Map<string, string>();
const deps: CleanupDeps = {
  logIssue: () => {},
  logIssueOnce: () => {},
  getState: (k) => store.get(k) ?? null,
  setState: (k, v) => void store.set(k, v),
};
const idle = () => ({ state: "idle" });

// 7 hash releases; index 0 oldest ... 6 newest. current = h0 (oldest), previous = h1.
const names = ["a00000000001", "a00000000002", "a00000000003", "a00000000004", "a00000000005", "a00000000006", "a00000000007"];

function setup(opts: { current?: string | null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relc-"));
  const root = path.join(tmp, "os");
  const rel = path.join(root, "releases");
  fs.mkdirSync(path.join(root, "shared/data"), { recursive: true });
  fs.writeFileSync(path.join(root, "shared/data/db.sqlite"), "important");
  fs.mkdirSync(rel, { recursive: true });
  const base = Date.now() / 1000 - 10000;
  names.forEach((n, i) => {
    const d = path.join(rel, n);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "file.txt"), "x".repeat(100 * (i + 1)));
    fs.symlinkSync(path.join(root, "shared/data"), path.join(d, "data"));
    fs.utimesSync(d, base + i * 100, base + i * 100);
  });
  for (const n of ["initial", "notahash"]) {
    fs.mkdirSync(path.join(rel, n));
    fs.writeFileSync(path.join(rel, n, "f"), "keep");
  }
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "f"), "keep");
  fs.symlinkSync(outside, path.join(rel, "deadbeef0000"));
  if (opts.current !== null) fs.symlinkSync(opts.current ?? path.join(rel, names[0]), path.join(root, "current"));
  fs.symlinkSync(path.join(rel, names[1]), path.join(root, "previous"));
  return { tmp, root, rel, outside };
}

const exists = (p: string) => fs.existsSync(p);

test("only protected releases survive; freedBytes matches; other things untouched", () => {
  const { root, rel, outside } = setup();
  const res = runReleaseCleanup("health-check", root, "/nowhere", idle, deps);
  // protected: current a..01, previous a..02, newest 3 (a..05,06,07). removed: a..03, a..04
  assert.deepEqual(res.removed.map((r) => r.name).sort(), [names[2], names[3]]);
  for (const n of [names[0], names[1], names[4], names[5], names[6]]) assert.ok(exists(path.join(rel, n)), n);
  assert.equal(res.freedBytes, res.removed.reduce((n, r) => n + r.bytes, 0));
  assert.ok(res.freedBytes > 0);
  assert.ok(exists(path.join(root, "shared/data/db.sqlite")));
  assert.ok(exists(path.join(rel, "initial/f")));
  assert.ok(exists(path.join(rel, "notahash/f")));
  assert.ok(exists(path.join(outside, "f")));
  assert.ok(fs.lstatSync(path.join(rel, "deadbeef0000")).isSymbolicLink());
  // second run is a no-op
  const again = runReleaseCleanup("health-check", root, "/nowhere", idle, deps);
  assert.equal(again.removed.length, 0);
});

test("missing or dangling current removes nothing", () => {
  const a = setup({ current: null });
  const r1 = runReleaseCleanup("health-check", a.root, "/nowhere", idle, deps);
  assert.equal(r1.removed.length, 0);
  assert.ok(r1.skippedReason);
  const b = setup({ current: "/nonexistent/path/zzz" });
  const r2 = runReleaseCleanup("health-check", b.root, "/nowhere", idle, deps);
  assert.equal(r2.removed.length, 0);
  assert.ok(r2.skippedReason);
  assert.ok(exists(path.join(b.rel, names[2])));
});

test("current outside releases removes nothing", () => {
  const s = setup();
  fs.unlinkSync(path.join(s.root, "current"));
  fs.symlinkSync(s.outside, path.join(s.root, "current"));
  const r = runReleaseCleanup("health-check", s.root, "/nowhere", idle, deps);
  assert.equal(r.removed.length, 0);
  assert.ok(r.skippedReason);
  assert.ok(exists(path.join(s.rel, names[2])));
});

test("deploy running removes nothing", () => {
  const s = setup();
  const r = runReleaseCleanup("health-check", s.root, "/nowhere", () => ({ state: "running" }), deps);
  assert.equal(r.removed.length, 0);
  assert.equal(r.skippedReason, "deploy running");
  assert.ok(exists(path.join(s.rel, names[2])));
});

test("release with a real data directory is skipped", () => {
  const s = setup();
  const d = path.join(s.rel, names[2], "data");
  fs.unlinkSync(d);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "real.db"), "real");
  const r = runReleaseCleanup("health-check", s.root, "/nowhere", idle, deps);
  assert.deepEqual(r.removed.map((x) => x.name), [names[3]]);
  assert.ok(exists(path.join(d, "real.db")));
});

test("4 or fewer releases removes nothing", () => {
  const s = setup();
  for (const n of names.slice(3)) fs.rmSync(path.join(s.rel, n), { recursive: true });
  const r = runReleaseCleanup("health-check", s.root, "/nowhere", idle, deps);
  assert.equal(r.removed.length, 0);
});
