import fs from "fs";
import path from "path";
import { syncFixPrStatuses, prNumberFromResult, type Deps, type FixRow } from "./fix-pr-status";

// One-time backfill of [MERGED]/[DEPLOYED]/[CLOSED] prefixes on older sent_to_github rows (#373-#480)
// that the rolling 20-row sync never reaches. Writes only the result prefix, never the status column.

const BATCH = 20;
export const BACKFILL_MARKER = "backfill-pr-status.done";

export type BackfillOpts = {
  markerPath?: string;
  select?: () => FixRow[] | Promise<FixRow[]>;
  makeDeps?: (rows: () => FixRow[]) => Promise<Deps>;
  exists?: (p: string) => boolean;
  writeMarker?: (p: string) => void;
};

export async function runPrBackfillOnce(opts: BackfillOpts = {}): Promise<{ ran: boolean; batches: number; failed: number }> {
  let markerPath = opts.markerPath;
  if (!markerPath) {
    const { DATA_DIR } = await import("./data-dir");
    markerPath = path.join(DATA_DIR, BACKFILL_MARKER);
  }
  const exists = opts.exists || ((p: string) => fs.existsSync(p));
  const writeMarker = opts.writeMarker || ((p: string) => fs.writeFileSync(p, new Date().toISOString() + "\n"));
  if (exists(markerPath)) return { ran: false, batches: 0, failed: 0 };

  const select =
    opts.select ||
    (async () => {
      const { default: db } = await import("./db");
      return db
        .prepare(
          `SELECT id, result FROM fix_proposals
           WHERE status='sent_to_github' AND kind='github' AND id BETWEEN 373 AND 480
             AND COALESCE(result,'') NOT LIKE '[PR OPEN%' AND COALESCE(result,'') NOT LIKE '[MERGED%'
             AND COALESCE(result,'') NOT LIKE '[DEPLOYED%' AND COALESCE(result,'') NOT LIKE '[CLOSED WITHOUT MERGE%'
           ORDER BY id DESC`
        )
        .all() as FixRow[];
    });
  const all = await select();

  let current: FixRow[] = [];
  const done = new Set<number>();
  const rows = () => current;
  let deps: Deps;
  if (opts.makeDeps) deps = await opts.makeDeps(rows);
  else {
    const { realDepsWith } = await import("./fix-pr-status");
    deps = await realDepsWith({ rows });
  }
  const origUpdate = deps.update;
  deps = {
    ...deps,
    rows,
    update: (id, result) => {
      origUpdate(id, result);
      done.add(id);
    },
  };

  let batches = 0;
  for (let i = 0; i < all.length; i += BATCH) {
    current = all.slice(i, i + BATCH);
    await syncFixPrStatuses(deps);
    batches++;
  }

  // Rows with no PR link can never get a prefix; every other row must have one before we mark done.
  const failed = all.filter((r) => prNumberFromResult(r.result) != null && !done.has(r.id)).length;
  if (failed === 0) writeMarker(markerPath);
  else deps.log(`fix-pr-backfill: ${failed} rows got no prefix; will retry on next boot`);
  return { ran: true, batches, failed };
}
