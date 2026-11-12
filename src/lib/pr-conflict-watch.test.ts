// Unit tests: PR conflict retries are capped/backed off, issues are deduped and grouped. No network, sends or agents.
import test from "node:test";
import assert from "node:assert/strict";
import db, { logIssue } from "./db";
import { handlePr, resolveClosedPrIssues } from "./pr-conflict-watch";
import { bumpOpenIssue } from "./issue-once";

function memStore() {
  const m = new Map<string, string>();
  return { get: (k: string): string | null => m.get(k) ?? null, set: (k: string, v: string): void => void m.set(k, v), m };
}

function deps(counter: { updates: number }, store: ReturnType<typeof memStore>) {
  return {
    getStatus: async () => ({ state: "OPEN", mergeable: "CONFLICTING", has_conflicts: true, behind_base: false }),
    updateBranch: async () => {
      counter.updates++;
      return { ok: false };
    },
    rebuild: async () => "skip",
    store,
  };
}

test("handlePr retries update-branch at most once per main sha", async () => {
  const c = { updates: 0 };
  const d = deps(c, memStore());
  const n = 987654;
  assert.equal(await handlePr(n, "engineer/x", "o/r", "sha1", d), "skip");
  assert.equal(await handlePr(n, "engineer/x", "o/r", "sha1", d), "already");
  assert.equal(c.updates, 1);
  await handlePr(n, "engineer/x", "o/r", "sha2", d);
  assert.equal(c.updates, 2);
});

test("handlePr backs off, then gives up after 3 failures", async () => {
  const c = { updates: 0 };
  const store = memStore();
  const d = deps(c, store);
  const n = 987655;
  assert.equal(await handlePr(n, "engineer/x", "o/r", "a", d), "skip");
  assert.equal(await handlePr(n, "engineer/x", "o/r", "b", d), "backoff");
  for (const sha of ["c", "d"]) {
    store.set(`prcw:${n}`, JSON.stringify({ fails: JSON.parse(store.get(`prcw:${n}`) || "{}").fails, next_at: 0 }));
    await handlePr(n, "engineer/x", "o/r", sha, d);
  }
  assert.equal(c.updates, 3);
  assert.equal(await handlePr(n, "engineer/x", "o/r", "e", d), "gave_up");
  assert.equal(c.updates, 3);
});

test("bumpOpenIssue keeps one open row and counts repeats", () => {
  const src = "test:bump";
  const msg = "bump test message";
  bumpOpenIssue(src, msg);
  bumpOpenIssue(src, msg);
  const rows = db.prepare("SELECT id, detail FROM issues WHERE source=? AND status='open'").all(src) as { id: number; detail: string | null }[];
  assert.equal(rows.length, 1);
  assert.equal((JSON.parse(rows[0].detail || "{}") as { count: number }).count, 2);
  db.prepare("UPDATE issues SET status='resolved' WHERE source=?").run(src);
});

test("logIssue collapses floods into one Grouped row", () => {
  const src = "test:flood";
  for (let i = 0; i < 16; i++) logIssue(src, `distinct ${i}`);
  const open = db.prepare("SELECT message FROM issues WHERE source=? AND status='open'").all(src) as { message: string }[];
  assert.equal(open.length, 16);
  assert.equal(open.filter((r) => r.message.startsWith("Grouped:")).length, 1);
  db.prepare("UPDATE issues SET status='resolved' WHERE source=?").run(src);
});

test("resolveClosedPrIssues resolves closed PRs and keeps open ones", () => {
  const src = "github";
  logIssue(src, "update-branch for PR #990001 failed: merge conflict (test)");
  logIssue(src, "update-branch for PR #990002 failed: merge conflict (test)");
  resolveClosedPrIssues([990002]);
  const st = (n: number): string =>
    (db.prepare("SELECT status FROM issues WHERE message LIKE ? ORDER BY id DESC LIMIT 1").get(`%PR #${n} %`) as { status: string }).status;
  assert.equal(st(990001), "resolved");
  assert.equal(st(990002), "open");
  db.prepare("UPDATE issues SET status='resolved' WHERE message LIKE '%PR #99000_ failed%(test)'").run();
});
