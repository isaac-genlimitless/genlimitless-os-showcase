import { test } from "node:test";
import assert from "node:assert/strict";
import { needsRebuild, queueRebuild, type RebuildDb } from "./fix-rebuild";
import { syncFixPrStatuses, type Deps, type GhView } from "./fix-pr-status";

type R = Record<string, unknown>;

function fakeDb(rows: R[]): RebuildDb {
  return {
    prepare: (sql: string) => ({
      get: (...a: unknown[]) => {
        if (/WHERE retry_of=\?/.test(sql)) return rows.find((r) => r.retry_of === a[0]);
        if (/WHERE id=\?/.test(sql)) return rows.find((r) => r.id === a[0]);
        return undefined;
      },
      run: (...a: unknown[]) => {
        if (/^INSERT/.test(sql)) {
          const id = rows.length + 1;
          rows.push({ id, title: a[1], retry_of: a[10], status: "pending_cos_review", diagnosis: a[2] });
          return { lastInsertRowid: id };
        }
        const r = rows.find((x) => x.id === a[1])!;
        r.result = String(r.result || "") + String(a[0]);
        return { lastInsertRowid: 0 };
      },
    }),
  };
}

const base = (): R[] => [{ id: 1, title: "Fix X", diagnosis: "d", result: "https://github.com/o/r/pull/9", status: "sent_to_github" }];

function run(rows: R[], view: GhView) {
  const db = fakeDb(rows);
  const deps: Deps = {
    rows: () => [{ id: 1, result: "Opened https://github.com/o/r/pull/9" }],
    gh: async () => view,
    isDeployed: () => false,
    update: () => {},
    issue: () => {},
    now: () => Date.now(),
    log: () => {},
    rebuild: (id, pr) => void queueRebuild(db, id, pr),
  };
  return syncFixPrStatuses(deps);
}

test("needsRebuild only for OPEN + CONFLICTING/DIRTY", () => {
  assert.equal(needsRebuild({ state: "OPEN", mergeable: "CONFLICTING" }), true);
  assert.equal(needsRebuild({ state: "OPEN", mergeStateStatus: "DIRTY" }), true);
  assert.equal(needsRebuild({ state: "OPEN", mergeStateStatus: "BEHIND", mergeable: "MERGEABLE" }), false);
  assert.equal(needsRebuild({ state: "MERGED", mergeable: "CONFLICTING" }), false);
});

test("conflicting open PR queues exactly one row, second run none", async () => {
  const rows = base();
  const view = { state: "OPEN", mergeable: "CONFLICTING" };
  await run(rows, view);
  await run(rows, view);
  assert.equal(rows.length, 2);
  assert.match(String(rows[1].title), /auto-rebuild of #1 on current main/);
  assert.equal(rows[1].retry_of, 1);
  assert.match(String(rows[0].result), /\[rebuild queued as #2\]/);
  assert.equal(rows[0].status, "sent_to_github");
});

test("clean or merged PR queues none", async () => {
  const rows = base();
  await run(rows, { state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
  await run(rows, { state: "MERGED", mergeable: "CONFLICTING" });
  assert.equal(rows.length, 1);
});
