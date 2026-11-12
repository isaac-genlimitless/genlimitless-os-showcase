import { test } from "node:test";
import assert from "node:assert/strict";
import { runPrBackfillOnce } from "./fix-pr-backfill";
import type { Deps, FixRow, GhView } from "./fix-pr-status";

const url = (n: number) => `Opened https://github.com/o/r/pull/${n}`;

function setup(count: number, view: (pr: number) => GhView | Error) {
  const rows: FixRow[] = Array.from({ length: count }, (_, i) => ({ id: 373 + i, result: url(1000 + i) }));
  const updates = new Map<number, string>();
  const batchSizes: number[] = [];
  const markers: string[] = [];
  let marked = false;
  const makeDeps = async (r: () => FixRow[]): Promise<Deps> => ({
    rows: () => {
      batchSizes.push(r().length);
      return r();
    },
    gh: async (pr) => {
      const v = view(pr);
      if (v instanceof Error) throw v;
      return v;
    },
    isDeployed: () => false,
    update: (id, result) => void updates.set(id, result),
    issue: () => {},
    now: () => Date.now(),
    log: () => {},
  });
  const opts = {
    markerPath: "/tmp/marker",
    select: () => rows,
    makeDeps,
    exists: () => marked,
    writeMarker: (p: string) => {
      markers.push(p);
      marked = true;
    },
  };
  return { opts, updates, batchSizes, markers };
}

test("45 rows run in 3 batches, marker once, second call is a no-op", async () => {
  const s = setup(45, () => ({ state: "CLOSED" }));
  const r = await runPrBackfillOnce(s.opts);
  assert.equal(r.batches, 3);
  assert.deepEqual(s.batchSizes, [20, 20, 5]);
  assert.equal(s.markers.length, 1);
  assert.equal(s.updates.size, 45);
  for (const v of s.updates.values()) assert.ok(v.startsWith("[CLOSED WITHOUT MERGE] "));
  const again = await runPrBackfillOnce(s.opts);
  assert.equal(again.ran, false);
  assert.equal(s.markers.length, 1);
});

test("marker is not written when GitHub fails for some rows", async () => {
  const s = setup(3, (pr) => (pr === 1001 ? new Error("boom") : { state: "OPEN" }));
  const r = await runPrBackfillOnce(s.opts);
  assert.equal(r.failed, 1);
  assert.equal(s.markers.length, 0);
});
