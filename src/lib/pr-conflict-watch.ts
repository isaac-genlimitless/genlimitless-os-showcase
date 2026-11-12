import cron from "node-cron";
import { execFile } from "child_process";
import db, { logIssue, getState, setState } from "./db";
import { bumpOpenIssue } from "./issue-once";
import { getPRStatus, updatePRBranch } from "./github";
import { getFixProposal, proposeFix } from "./agents/fixes";

// Watches open engineer/* PRs. When main moves (a PR merged) or every 10 minutes, any PR that is
// CONFLICTING or BEHIND gets GitHub's update-branch; if that hits a conflict, one superseding
// proposal is filed to rebuild the change on current main. Never merges, closes or force-pushes.

const SCAN_EVERY_MS = 10 * 60_000;
type WatchState = { started?: boolean; running?: boolean; sha?: string; lastScan: number; lastErr?: string; tried: Map<number, string> };
function state(): WatchState {
  const g = globalThis as { __prConflictWatch?: WatchState };
  return (g.__prConflictWatch ??= { lastScan: 0, tried: new Map<number, string>() });
}

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("gh", args, { timeout: 60_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim())
    )
  );
}

export function decideAction(st: { state: string; mergeable: string; has_conflicts: boolean; behind_base: boolean }): "skip" | "pending" | "ok" | "update" {
  if (st.state !== "OPEN") return "skip";
  if (st.has_conflicts || st.behind_base) return "update";
  if (st.mergeable === "UNKNOWN") return "pending"; // GitHub is still computing it; look again next tick
  return "ok";
}

export function rebuildTitle(title: string, n: number): string {
  return `Rebuild PR #${n} on current main: ${title.replace(/^Rebuild PR #\d+ on current main: /, "")}`.slice(0, 200);
}

async function rebuild(n: number, head: string, repo: string): Promise<string> {
  const m = /^engineer\/fix-(\d+)$/.exec(head);
  const orig = m ? getFixProposal(Number(m[1])) : undefined;
  if (!orig || orig.repo) return "skip";
  const seen = db.prepare(`SELECT id FROM fix_proposals WHERE diagnosis LIKE ? LIMIT 1`).get(`Supersedes conflicting PR #${n} %`);
  if (seen) return "already";
  let files: string[] = [];
  try {
    files = JSON.parse(orig.files || "[]");
  } catch {}
  const r: any = proposeFix({
    title: rebuildTitle(orig.title, n),
    diagnosis: `Supersedes conflicting PR #${n} (branch ${head}, original proposal #${orig.id}). It cannot be merged and GitHub could not bring it up to date with main, so the same change must be rebuilt on current main.\n\n${orig.diagnosis}`,
    proposed_change: `REBUILD ON CURRENT MAIN. PR #${n} (original proposal #${orig.id}) conflicts with main. Re-apply the intended change below against the latest main, keeping everything main now contains.\n\nORIGINAL CHANGE:\n${orig.proposed_change}`,
    files,
    kind: "github",
    proposed_by: "full_stack_engineer",
  });
  if (!r.proposal_id) {
    bumpOpenIssue("github:pr_conflict_watch", `Could not file the rebuild of PR #${n}`, { result: JSON.stringify(r).slice(0, 400) });
    return "failed";
  }
  try {
    await gh([
      "pr", "comment", String(n), "--repo", repo, "--body",
      `[auto] Superseded: this PR conflicts with main and could not be updated automatically. The same change is being rebuilt on current main as fix proposal #${r.proposal_id}. This PR is left open for reference.`,
    ]);
  } catch (e: any) {
    bumpOpenIssue("github:pr_conflict_watch", `Rebuild filed but commenting on PR #${n} failed`, { error: String(e?.message || e).slice(0, 300), proposal_id: r.proposal_id });
  }
  db.prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant', ?)`).run(
    `PR #${n} conflicted with main, so I queued a rebuild on current main (proposal #${r.proposal_id}).`
  );
  return "rebuild";
}

export type HandleDeps = {
  getStatus: (n: number) => Promise<any>;
  updateBranch: (n: number) => Promise<{ ok: boolean }>;
  rebuild: (n: number, head: string, repo: string) => Promise<string>;
  store?: { get: (k: string) => string | null; set: (k: string, v: string) => void };
};

export async function handlePr(n: number, head: string, repo: string, sha?: string, deps?: Partial<HandleDeps>): Promise<string> {
  const getStatus = deps?.getStatus ?? getPRStatus;
  const updateBranch = deps?.updateBranch ?? updatePRBranch;
  const doRebuild = deps?.rebuild ?? rebuild;
  const action = decideAction(await getStatus(n));
  if (action !== "update") return action;
  const s = state();
  // A PR that already failed update-branch on this main commit cannot succeed until main moves again.
  if (sha && s.tried.get(n) === sha) return "already";
  const store = deps?.store ?? { get: getState, set: setState };
  const key = `prcw:${n}`;
  let bo: BackoffState = { fails: 0, next_at: 0 };
  try {
    bo = JSON.parse(store.get(key) || "{}") as BackoffState;
  } catch {
    bo = { fails: 0, next_at: 0 };
  }
  const fails = Number(bo.fails) || 0;
  const nextAt = Number(bo.next_at) || 0;
  if (fails >= 3) return "gave_up";
  if (Date.now() < nextAt) return "backoff";
  const fail = (): void => {
    store.set(key, JSON.stringify({ fails: fails + 1, next_at: Date.now() + 3600000 * 4 ** fails }));
  };
  const up = await updateBranch(n);
  if (up.ok) {
    store.set(key, JSON.stringify({ fails: 0, next_at: 0 }));
    return "updated";
  }
  if (sha) s.tried.set(n, sha);
  const result = await doRebuild(n, head, repo);
  fail();
  return result;
}

type BackoffState = { fails: number; next_at: number };

/** Marks open PR-related issues resolved when their PR is no longer open. Nothing is deleted. */
export function resolveClosedPrIssues(openNumbers: number[]): number {
  const rows = db
    .prepare(`SELECT id, message FROM issues WHERE status='open' AND source IN ('github','github:pr_conflict_watch')`)
    .all() as { id: number; message: string }[];
  const open = new Set<number>(openNumbers);
  let count = 0;
  for (const r of rows) {
    const m = /PR #(\d+)/.exec(r.message);
    if (!m || open.has(Number(m[1]))) continue;
    db.prepare(
      `UPDATE issues SET status='resolved', resolved_at=datetime('now'), detail=COALESCE(detail,'') || ' | auto-resolved: PR no longer open' WHERE id=?`
    ).run(r.id);
    count++;
  }
  return count;
}

export async function scanOpenPrs(): Promise<string[]> {
  const sha = state().sha;
  const repo = process.env.GITHUB_REPO;
  if (!repo) return [];
  const list = JSON.parse(await gh(["pr", "list", "--repo", repo, "--state", "open", "--json", "number,headRefName", "--limit", "50"])) as { number: number; headRefName: string }[];
  const out: string[] = [];
  if (list.length < 50) resolveClosedPrIssues(list.map((p) => p.number));
  for (const p of list) {
    if (!p.headRefName.startsWith("engineer/")) continue;
    try {
      out.push(`${p.number}:${await handlePr(p.number, p.headRefName, repo, sha)}`);
    } catch (e: any) {
      logIssue("github:pr_conflict_watch", `Checking PR #${p.number} failed`, e.message);
    }
  }
  return out;
}

export async function prConflictTick() {
  const s = state();
  if (s.running) return;
  s.running = true;
  try {
    const repo = process.env.GITHUB_REPO;
    if (!repo) return;
    const sha = await gh(["api", `repos/${repo}/commits/main`, "--jq", ".sha"]);
    if (sha !== s.sha || Date.now() - s.lastScan >= SCAN_EVERY_MS) {
      s.sha = sha;
      s.lastScan = Date.now();
      const res = await scanOpenPrs();
      if (res.some((x) => x.endsWith(":pending"))) s.lastScan = 0; // recheck on the next tick
    }
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300);
    if (msg !== s.lastErr) logIssue("github:pr_conflict_watch", "PR conflict check failed", msg);
    s.lastErr = msg;
  } finally {
    s.running = false;
  }
}

export function startPrConflictWatch() {
  const s = state();
  if (s.started) return;
  s.started = true;
  cron.schedule("*/2 * * * *", () => void prConflictTick(), { timezone: "America/Chicago" });
  void prConflictTick();
}
