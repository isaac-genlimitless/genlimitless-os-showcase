import { test, expect } from "./isolated-test";
import Database from "better-sqlite3";
import { classifyFailure, parseResetTime, retryFailedFixes } from "../src/lib/fix-retry";
import { precheckProposal } from "../src/lib/agents/fixes";

// Pure in-memory tests: never sends anything or runs an agent (enqueue/escalate are stubbed).
const NOW = new Date("2026-10-08T12:00:00");

function mkdb() {
  const mem = new Database(":memory:");
  mem.exec(`CREATE TABLE fix_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER, title TEXT NOT NULL, diagnosis TEXT NOT NULL DEFAULT 'd',
    proposed_change TEXT NOT NULL DEFAULT 'c', files TEXT, status TEXT NOT NULL DEFAULT 'pending_approval', result TEXT,
    kind TEXT NOT NULL DEFAULT 'github', size TEXT, size_reasons TEXT, cos_review TEXT, proposed_by TEXT, repo TEXT,
    retry_of INTEGER, retry_count INTEGER DEFAULT 0, fail_kind TEXT, retry_after TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  return mem;
}
function failed(mem: Database.Database, o: Record<string, unknown> = {}) {
  const r = { title: "T", status: "failed", size: "minor", cos_review: "[Chief of Staff: approve] ok", fail_kind: "other", retry_count: 0, retry_after: null, result: "boom", ...o };
  return Number(
    mem
      .prepare(`INSERT INTO fix_proposals (title,status,size,cos_review,fail_kind,retry_count,retry_after,result,retry_of) VALUES (@title,@status,@size,@cos_review,@fail_kind,@retry_count,@retry_after,@result,@retry_of)`)
      .run({ retry_of: null, ...r }).lastInsertRowid
  );
}
const get = (mem: Database.Database, id: number) => mem.prepare(`SELECT * FROM fix_proposals WHERE id=?`).get(id) as any;

test("classifier maps errors to fail_kind and parses the reset time", () => {
  expect(classifyFailure("Claude usage limit reached. Resets at 3pm", NOW).kind).toBe("usage_limit");
  expect(classifyFailure("Stopped early: 529 overloaded", NOW).retryAfter).not.toBeNull();
  expect(classifyFailure("Couldn't push the branch to GitHub.").kind).toBe("transient");
  expect(classifyFailure("It changed package.json, which has to go through a normal PR").kind).toBe("policy");
  expect(classifyFailure("The code didn't type-check after the change. error TS2322").kind).toBe("typecheck");
  expect(classifyFailure("something odd").kind).toBe("other");
  expect(parseResetTime("resets at 3pm", NOW)!.getHours()).toBe(15);
  expect(parseResetTime("nothing here", NOW)).toBeNull();
});

test("usage_limit waits for retry_after, then retries once and links to the original", () => {
  const mem = mkdb();
  const enq: number[] = [];
  const later = new Date(NOW.getTime() + 3600_000).toISOString();
  const id = failed(mem, { fail_kind: "usage_limit", retry_after: later });
  expect(retryFailedFixes({ database: mem, now: NOW, enqueue: (i) => void enq.push(i), escalate: () => {} }).retried).toEqual([]);
  const r = retryFailedFixes({ database: mem, now: new Date(NOW.getTime() + 7200_000), enqueue: (i) => void enq.push(i), escalate: () => {} });
  expect(r.retried.length).toBe(1);
  const n = get(mem, r.retried[0]);
  expect(n.retry_of).toBe(id);
  expect(n.retry_count).toBe(1);
  expect(n.status).toBe("cos_approved");
  expect(n.title).toContain("auto-retry 1/2 of #" + id);
  expect(get(mem, id).result).toContain(`→ retried as #${n.id}`);
  // never retried again once a row with retry_of exists
  expect(retryFailedFixes({ database: mem, now: new Date(NOW.getTime() + 9e6), enqueue: () => {}, escalate: () => {} }).retried).toEqual([]);
  mem.close();
});

test("stops at 2 retries and alerts Owner exactly once", () => {
  const mem = mkdb();
  const alerts: unknown[] = [];
  const id = failed(mem, { retry_count: 2 });
  const deps = { database: mem, now: NOW, enqueue: () => {}, escalate: (a: unknown) => void alerts.push(a) };
  expect(retryFailedFixes(deps).retried).toEqual([]);
  retryFailedFixes(deps);
  expect(alerts.length).toBe(1);
  expect(get(mem, id).status).toBe("failed");
  mem.close();
});

test("no alert on a first failure", () => {
  const mem = mkdb();
  const alerts: unknown[] = [];
  failed(mem, { retry_count: 1 });
  retryFailedFixes({ database: mem, now: NOW, enqueue: () => {}, escalate: (a) => void alerts.push(a) });
  expect(alerts.length).toBe(0);
  mem.close();
});

test("unapproved major original becomes pending_approval and is not enqueued", () => {
  const mem = mkdb();
  const enq: number[] = [];
  failed(mem, { size: "major", cos_review: null });
  const r = retryFailedFixes({ database: mem, now: NOW, enqueue: (i) => void enq.push(i), escalate: () => {} });
  expect(get(mem, r.retried[0]).status).toBe("pending_approval");
  expect(enq).toEqual([]);
  mem.close();
});

test("policy failure routes to a revision for review, not a blind retry", () => {
  const mem = mkdb();
  const enq: number[] = [];
  const id = failed(mem, { fail_kind: "policy", result: "It changed package.json" });
  const r = retryFailedFixes({ database: mem, now: NOW, enqueue: (i) => void enq.push(i), escalate: () => {} });
  const n = get(mem, r.retried[0]);
  expect(n.status).toBe("pending_cos_review");
  expect(n.diagnosis).toContain("Revise #" + id);
  expect(n.diagnosis).toContain("It changed package.json");
  expect(enq).toEqual([]);
  mem.close();
});

test("pre-checks reject builder-forbidden files, big changes and new dependencies on the server", () => {
  expect(precheckProposal({ files: ["package.json"], proposed_change: "x" }, true)).toContain("split to a normal PR");
  expect(precheckProposal({ files: Array(9).fill("a.ts"), proposed_change: "x" }, true)).toContain("≤6 files");
  expect(precheckProposal({ files: ["a.ts"], proposed_change: "add a new dependency" }, true)).not.toBeNull();
  expect(precheckProposal({ files: ["a.ts"], proposed_change: "tweak" }, true)).toBeNull();
  expect(precheckProposal({ files: ["package.json"], proposed_change: "x" }, false)).toBeNull();
});
