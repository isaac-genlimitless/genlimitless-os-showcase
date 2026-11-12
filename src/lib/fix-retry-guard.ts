import { execFileSync } from "child_process";
import { parseDeclaredParents, parentState } from "./fix-deps";

// Retry guard: a failed fix is only retried once something changed. Both must hold:
//  (a) every declared parent is merged into main, and
//  (b) main's commit differs from the one recorded when the failed attempt was built ("[base abc1234]" in result).
// Rows with no base note (legacy) count as "different", so they still retry.

export type GuardRow = { id: number; proposed_change?: string | null; diagnosis?: string | null; cos_review?: string | null; result?: string | null };

export type GuardDeps = {
  /** Sync answer for "is this parent merged into main?" (default: cached result of parentState, refreshed in the background). */
  parentMerged?: (id: number) => boolean;
};

export function baseNote(oid: string): string {
  return `[base ${oid.slice(0, 7)}]`;
}

export function parseBaseNote(result: string | null | undefined): string | null {
  const all = [...(result ?? "").matchAll(/\[base ([0-9a-f]{7,40})\]/gi)];
  return all.length ? all[all.length - 1][1].toLowerCase() : null;
}

/** Current commit of main (short-circuits to null if it can't be read). */
export function currentMainOid(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "origin/main"], { timeout: 10_000, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const merged = new Map<number, boolean>();

function cachedParentMerged(id: number): boolean {
  // parentState is async; start a refresh and answer from the last known result (first tick waits, next tick sees it).
  parentState(id)
    .then((p) => void merged.set(id, p.ok))
    .catch(() => void merged.set(id, false));
  return merged.get(id) === true;
}

export function retryReady(row: GuardRow & { id: number }, mainOid: string | null, deps: GuardDeps = {}): boolean {
  const isMerged = deps.parentMerged ?? cachedParentMerged;
  for (const pid of parseDeclaredParents({ id: row.id, proposed_change: row.proposed_change, diagnosis: row.diagnosis, cos_review: row.cos_review })) {
    if (!isMerged(pid)) return false;
  }
  const built = parseBaseNote(row.result);
  if (!built || !mainOid) return true;
  const main = mainOid.toLowerCase();
  return !(main.startsWith(built) || built.startsWith(main));
}
