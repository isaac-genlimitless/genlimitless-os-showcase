import cron from "node-cron";
import { execFile } from "child_process";
import db, { logIssue } from "./db";

// Fix dependencies: a fix that builds on an earlier fix waits until that fix's PR is merged, then starts by
// itself (only if it is a minor, Chief-of-Staff-approved row; major rows still wait for Owner).

const APPROVED = "[Chief of Staff: approve]"; // same test as fix-retry.ts
const MARK = "[auto-release]";
const OPEN_STATUSES = ["applying", "cos_approved", "sent_to_github", "pending_approval"];

export type DepRow = {
  id: number;
  status: string;
  result?: string | null;
  files?: string | null;
  size?: string | null;
  cos_review?: string | null;
  proposed_change?: string | null;
  diagnosis?: string | null;
  retry_of?: number | null;
  supersedes?: number | null;
};

export type Parent = { id: number; ok: boolean; reason: string; files: string[] };

export type Deps = {
  getRow: (id: number) => DepRow | undefined;
  /** Rows that replaced `id` (supersedes=id or retry_of=id), newest first. */
  children: (id: number) => DepRow[];
  /** Earlier, unmerged proposals (lower id, status applying/cos_approved/sent_to_github/pending_approval). */
  candidates: (beforeId: number) => DepRow[];
  /** Later rows whose text says they replace/supersede `id`, newest first. */
  replacers?: (id: number) => DepRow[];
  waiting: () => DepRow[];
  prState: (n: number) => Promise<string>;
};

function ghPrState(n: number): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("gh", ["pr", "view", String(n), "--repo", process.env.GITHUB_REPO || "", "--json", "state", "-q", ".state"], { timeout: 60_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim())
    )
  );
}

/** True when a later row's review/diagnosis says it replaces or supersedes proposal `id`. */
export function mentionsReplacement(row: DepRow, id: number): boolean {
  if (!(row.id > id)) return false;
  const re = new RegExp(`(?:replaces|supersedes|superseded\\s+by)\\b[^.\\n]*?#${id}\\b`, "i");
  return re.test((row.cos_review || "") + "\n" + (row.diagnosis || ""));
}

export const realDeps: Deps = {
  getRow: (id) => db.prepare(`SELECT * FROM fix_proposals WHERE id=?`).get(id) as DepRow | undefined,
  children: (id) => db.prepare(`SELECT * FROM fix_proposals WHERE supersedes=? OR retry_of=? ORDER BY id DESC`).all(id, id) as DepRow[],
  replacers: (id) =>
    (
      db
        .prepare(`SELECT * FROM fix_proposals WHERE id>? AND (cos_review LIKE ? OR diagnosis LIKE ?) ORDER BY id DESC`)
        .all(id, `%#${id}%`, `%#${id}%`) as DepRow[]
    ).filter((r) => mentionsReplacement(r, id)),
  candidates: (beforeId) =>
    db
      .prepare(`SELECT * FROM fix_proposals WHERE id<? AND status IN (${OPEN_STATUSES.map(() => "?").join(",")}) ORDER BY id DESC`)
      .all(beforeId, ...OPEN_STATUSES) as DepRow[],
  waiting: () =>
    db.prepare(`SELECT * FROM fix_proposals WHERE status='pending_approval' AND result LIKE 'Waiting:%' AND result LIKE ?`).all(`%${MARK}%`) as DepRow[],
  prState: ghPrState,
};

function filesOf(r: DepRow): string[] {
  try {
    const f = JSON.parse(r.files || "[]");
    return Array.isArray(f) ? f.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Proposal ids named by `REQUIRES_FIX: #N, #M` or `Apply after #N, #M`. Ids >= the row's own id are ignored. */
export function parseDeclaredParents(row: { id: number; proposed_change?: string | null; diagnosis?: string | null; cos_review?: string | null }): number[] {
  const text = [row.proposed_change, row.diagnosis, row.cos_review].filter(Boolean).join("\n");
  const ids = new Set<number>();
  const re = /(?:REQUIRES_FIX:|Apply\s+after)\s*((?:#?\d+)(?:\s*(?:,|and|&)\s*#?\d+)*)/gi;
  for (const m of text.matchAll(re)) {
    for (const n of m[1].matchAll(/\d+/g)) {
      const id = Number(n[0]);
      if (id > 0 && id < row.id) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Follow revised/retried proposals forward (newest first, max depth 5).
 * `selfId` is the row doing the waiting: it is skipped, so a fix never resolves its parent forward to itself
 * (a rebuild of #502 is #502's newest child, which used to make it wait on itself forever).
 */
export function resolveParent(id: number, deps: Deps = realDeps, selfId?: number): number {
  const notSelf = (r: DepRow) => r.id !== selfId;
  let cur = id;
  for (let i = 0; i < 5; i++) {
    const next = deps.children(cur).find(notSelf) ?? deps.replacers?.(cur).find(notSelf);
    if (!next) break;
    cur = next.id;
  }
  return cur;
}

export async function parentState(id: number, deps: Deps = realDeps): Promise<Parent> {
  const row = deps.getRow(id);
  if (!row) return { id, ok: false, reason: "not found", files: [] };
  const files = filesOf(row);
  if (row.status === "applied") return { id, ok: true, reason: "applied", files };
  if (row.status === "sent_to_github") {
    const n = /\/pull\/(\d+)/.exec(row.result || "")?.[1];
    if (!n) return { id, ok: false, reason: "sent_to_github (PR number unknown)", files };
    try {
      const state = await deps.prState(Number(n));
      if (state === "MERGED") return { id, ok: true, reason: `PR #${n} merged`, files };
      return { id, ok: false, reason: `PR #${n} is ${state || "OPEN"}`, files };
    } catch {
      return { id, ok: false, reason: `PR #${n} couldn't be checked`, files };
    }
  }
  return { id, ok: false, reason: row.status, files };
}

/** True when `self` is itself the revision/rebuild of `parentId` (so that parent's open PR is what it replaces, not a prerequisite). */
function replacesParent(self: DepRow | undefined, parentId: number): boolean {
  if (!self) return false;
  return self.retry_of === parentId || self.supersedes === parentId || mentionsReplacement(self, parentId);
}

/** `selfId` = the row that is waiting; it is never its own parent, nor is a parent it replaces. */
export async function evaluateParents(ids: number[], deps: Deps = realDeps, selfId?: number): Promise<Parent[]> {
  const out: Parent[] = [];
  const seen = new Set<number>();
  const self = selfId === undefined ? undefined : deps.getRow(selfId);
  for (const id of ids) {
    const r = resolveParent(id, deps, selfId);
    if (selfId !== undefined && (r === selfId || replacesParent(self, r))) continue;
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(await parentState(r, deps));
  }
  return out;
}

/** Files that are missing on fresh main but listed by an earlier unmerged proposal => implicit parents. */
export function inferParentsFromFiles(files: string[], existsOnMain: (f: string) => boolean, candidates: DepRow[]): number[] {
  const ids = new Set<number>();
  for (const f of files) {
    if (existsOnMain(f)) continue;
    const hit = candidates.find((c) => filesOf(c).includes(f));
    if (hit) ids.add(hit.id);
  }
  return [...ids];
}

/** `Cannot find module '...'` / `has no exported member` errors that point at files of unmerged earlier proposals. */
export function inferParentsFromErrors(tscErrorText: string, candidates: DepRow[]): number[] {
  const ids = new Set<number>();
  for (const line of tscErrorText.split("\n")) {
    const a = /Cannot find module '([^']+)'/.exec(line);
    const b = /Module '"([^"]+)"' has no exported member/.exec(line);
    const mod = a?.[1] || b?.[1];
    if (!mod) continue;
    const last = mod.split("/").pop()?.replace(/\.(ts|tsx|js)$/, "");
    if (!last) continue;
    for (const c of candidates) {
      if (filesOf(c).some((f) => f.replace(/\.(ts|tsx|js)$/, "").split("/").pop() === last)) ids.add(c.id);
    }
  }
  return [...ids];
}

export function waitingMessage(parents: Parent[]): string {
  const bad = parents.filter((p) => !p.ok);
  const list = bad.map((p) => `#${p.id} (${p.reason.replace(/ is OPEN$/, " still OPEN")})`).join(", ");
  const files = [...new Set(bad.flatMap((p) => p.files))].join(", ") || "(none listed)";
  return `Waiting: this builds on ${list}. Nothing was built. It starts by itself once they are merged. Files from those parents that must be on main first: ${files}. ${MARK}`;
}

export function mergedNote(parents: Parent[]): string {
  if (!parents.length) return "";
  return `Parent fixes already merged on main: ${parents.map((p) => `#${p.id} (files ${p.files.join(", ") || "none listed"})`).join("; ")}. Use them; don't recreate them.`;
}

export async function releaseWaitingFixes(deps: Deps = realDeps, apply?: (id: number) => unknown): Promise<number[]> {
  const started: number[] = [];
  for (const row of deps.waiting()) {
    const ids = parseDeclaredParents(row);
    // Parents (declared or inferred) named in the stored waiting message
    for (const m of (row.result || "").matchAll(/#(\d+) \(/g)) {
      const id = Number(m[1]);
      if (id < row.id) ids.push(id);
    }
    const unique = [...new Set(ids)];
    if (!unique.length) continue;
    const parents = await evaluateParents(unique, deps, row.id);
    if (parents.some((p) => !p.ok)) continue;
    if (row.size === "minor" && (row.cos_review || "").startsWith(APPROVED)) {
      started.push(row.id);
      if (apply) await apply(row.id);
      else await (await import("./ops")).applyFixProposal(row.id, "chief_of_staff");
    } else {
      db.prepare(`UPDATE fix_proposals SET result=? WHERE id=? AND status='pending_approval'`).run("Parents are merged; ready for approval.", row.id);
    }
  }
  return started;
}

type WatchState = { started?: boolean; running?: boolean };
export function startFixDepsWatch() {
  if (!process.env.GITHUB_REPO) return;
  const g = globalThis as { __fixDepsWatch?: WatchState };
  const s = (g.__fixDepsWatch ??= {});
  if (s.started) return;
  s.started = true;
  cron.schedule(
    "*/3 * * * *",
    async () => {
      if (s.running) return;
      s.running = true;
      try {
        await releaseWaitingFixes();
      } catch (e: any) {
        logIssue("fix_deps", "Fix dependency check failed", String(e?.message || e).slice(0, 300));
      } finally {
        s.running = false;
      }
    },
    { timezone: "America/Chicago" }
  );
}
