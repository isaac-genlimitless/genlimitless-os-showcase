// Unit tests: overlap warnings on new fix proposals. In-memory fake rows, no db, network, sends or agents.
import test from "node:test";
import assert from "node:assert/strict";
import { findOverlaps, noteFor, sweepOverlaps, type OverlapRow } from "./fix-overlap";

const NOW = Date.parse("2026-11-05T12:00:00Z");
function at(minAgo: number): string {
  return new Date(NOW - minAgo * 60_000).toISOString().slice(0, 19).replace("T", " ");
}
function row(id: number, title: string, files: string[], minAgo: number, extra: Partial<OverlapRow> = {}): OverlapRow {
  return { id, title, status: "pending_cos_review", files: JSON.stringify(files), created_at: at(minAgo), diagnosis: "diag", proposed_by: "full_stack_engineer", ...extra };
}
function fakeDb(rows: OverlapRow[]) {
  return {
    prepare: (sql: string) => ({
      all: () => rows,
      run: (note: string, id: number) => {
        const r = rows.find((x) => x.id === id);
        if (!r || r.status !== "pending_cos_review" || (r.diagnosis || "").includes("[overlap-check]")) return { changes: 0 };
        r.diagnosis = (r.diagnosis || "") + note;
        return { changes: 1 };
      },
    }),
  };
}

test("iphone stale-page style attempts are flagged", () => {
  const a = row(493, "iPhone shows stale page after deploy", ["src/app/layout.tsx"], 15);
  const b = row(494, "Stop iPhone serving cached stale layout", ["src/app/layout.tsx", "src/x.ts"], 12);
  const c = row(497, "Different wording entirely", ["src/app/layout.tsx"], 1);
  const ov = findOverlaps(c, [a, b, c], NOW);
  assert.deepEqual(ov.map((o) => o.id), [494, 493]);
  assert.deepEqual(ov[0].sharedFiles, ["src/app/layout.tsx"]);
  const byWords = findOverlaps(row(500, "iPhone stale cached layout problem", [], 0), [a, b], NOW);
  assert.ok(byWords.find((o) => o.id === 494)!.sharedWords.length >= 3);
  assert.match(noteFor(ov), /\[overlap-check\]/);
});

test("unrelated rows are not flagged", () => {
  const a = row(1, "Calendar sync drops events", ["src/cal.ts"], 5);
  const b = row(2, "iPhone shows stale page", ["src/app/layout.tsx"], 5);
  assert.equal(findOverlaps(b, [a, b], NOW).length, 0);
});

test("own retry/supersede chain, old rows, cleanup and dismissed are ignored", () => {
  const a = row(10, "Same", ["src/a.ts"], 30);
  const retry = row(11, "Same", ["src/a.ts"], 20, { retry_of: 10 });
  const sup = row(12, "Same", ["src/a.ts"], 10, { supersedes: 11 });
  assert.equal(findOverlaps(sup, [a, retry, sup], NOW).length, 0);
  assert.equal(findOverlaps(a, [a, retry, sup], NOW).length, 0);
  const old = row(5, "Same", ["src/a.ts"], 25 * 60);
  const cl = row(6, "Same", ["src/a.ts"], 5, { proposed_by: "cleanup" });
  const dis = row(7, "Same", ["src/a.ts"], 5, { status: "dismissed" });
  assert.equal(findOverlaps(row(20, "New", ["src/a.ts"], 0), [old, cl, dis], NOW).length, 0);
});

test("sweep is idempotent and only touches pending_cos_review rows", () => {
  const a = row(1, "First", ["src/a.ts"], 20, { status: "applied" });
  const b = row(2, "Second", ["src/a.ts"], 5);
  const c = row(3, "Third", ["src/a.ts"], 4, { status: "pending_approval" });
  const rows = [c, b, a];
  assert.equal(sweepOverlaps(fakeDb(rows), NOW), 1);
  assert.match(b.diagnosis!, /\[overlap-check\]/);
  assert.equal(a.diagnosis, "diag");
  assert.equal(c.diagnosis, "diag");
  const after = b.diagnosis;
  assert.equal(sweepOverlaps(fakeDb(rows), NOW), 0);
  assert.equal(b.diagnosis, after);
});
