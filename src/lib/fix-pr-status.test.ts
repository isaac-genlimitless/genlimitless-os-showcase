import { test } from "node:test";
import assert from "node:assert/strict";
import { syncFixPrStatuses, stripPrefix, prNumberFromResult, type Deps, type FixRow, type GhView } from "./fix-pr-status";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const url = (n: number) => `Opened https://github.com/o/r/pull/${n}`;

function setup(rows: FixRow[], view: GhView | Error, deployed = false) {
  const issues: string[] = [];
  const logs: string[] = [];
  const deps: Deps = {
    rows: () => rows,
    gh: async () => {
      if (view instanceof Error) throw view;
      return view;
    },
    isDeployed: () => deployed,
    update: (id, result) => {
      const r = rows.find((x) => x.id === id)!;
      r.result = result;
    },
    issue: (m) => issues.push(m),
    now: () => NOW,
    log: (m) => logs.push(m),
  };
  return { deps, issues, logs };
}

test("parses PR number and strips only our marker", () => {
  assert.equal(prNumberFromResult(url(7)), 7);
  assert.equal(prNumberFromResult("no link"), null);
  assert.equal(stripPrefix("[MERGED, not deployed yet] hi"), "hi");
  assert.equal(stripPrefix("[other] hi"), "[other] hi");
});

test("open PR gets [PR OPEN], replaced not stacked", async () => {
  const rows = [{ id: 1, result: url(5) }];
  const { deps, issues } = setup(rows, { state: "OPEN" });
  await syncFixPrStatuses(deps);
  await syncFixPrStatuses(deps);
  assert.equal(rows[0].result, `[PR OPEN] ${url(5)}`);
  assert.equal(issues.length, 0);
});

test("merged and deployed", async () => {
  const rows = [{ id: 1, result: url(5) }];
  const { deps } = setup(rows, { state: "MERGED", mergedAt: "2026-11-05T11:00:00Z", mergeCommit: { oid: "abc" } }, true);
  await syncFixPrStatuses(deps);
  assert.ok(rows[0].result!.startsWith("[DEPLOYED] "));
});

test("merged not deployed: issue only after 2h", async () => {
  const old = [{ id: 1, result: url(5) }];
  const a = setup(old, { state: "MERGED", mergedAt: "2026-11-05T08:00:00Z", mergeCommit: { oid: "abc" } });
  await syncFixPrStatuses(a.deps);
  assert.ok(old[0].result!.startsWith("[MERGED, not deployed yet] "));
  assert.equal(a.issues.length, 1);
  const fresh = [{ id: 2, result: url(6) }];
  const b = setup(fresh, { state: "MERGED", mergedAt: "2026-11-05T11:30:00Z", mergeCommit: { oid: "abc" } });
  await syncFixPrStatuses(b.deps);
  assert.equal(b.issues.length, 0);
});

test("closed unmerged raises issue", async () => {
  const rows = [{ id: 1, result: url(5) }];
  const { deps, issues } = setup(rows, { state: "CLOSED", closedAt: "2026-11-05T10:00:00Z" });
  await syncFixPrStatuses(deps);
  assert.ok(rows[0].result!.startsWith("[CLOSED WITHOUT MERGE] "));
  assert.equal(issues.length, 1);
});

test("terminal rows, rows without PR URL skipped; gh error leaves row unchanged", async () => {
  const rows = [
    { id: 1, result: `[DEPLOYED] ${url(5)}` },
    { id: 2, result: "no pr here" },
    { id: 3, result: url(9) },
  ];
  const { deps, logs } = setup(rows, new Error("boom"));
  await syncFixPrStatuses(deps);
  assert.equal(rows[0].result, `[DEPLOYED] ${url(5)}`);
  assert.equal(rows[1].result, "no pr here");
  assert.equal(rows[2].result, url(9));
  assert.equal(logs.length, 1);
});
