import { execFile } from "child_process";
import { needsRebuild, queueRebuild, type RebuildDb } from "./fix-rebuild";

// Shows the real state of a fix's PR (open / merged / deployed / closed) as a one-line prefix on
// fix_proposals.result. The status column is never touched (auto-merge depends on 'sent_to_github').

const MARKER = /^\[(PR OPEN|MERGED, not deployed yet|DEPLOYED|CLOSED WITHOUT MERGE)[^\]]*\]\s*/;
const TWO_HOURS = 2 * 60 * 60 * 1000;

export function prNumberFromResult(result: string | null | undefined): number | null {
  const m = /github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/.exec(result || "");
  return m ? Number(m[1]) : null;
}

export function stripPrefix(result: string): string {
  return (result || "").replace(MARKER, "");
}

export type PrInfo = { state: string; mergedAt?: string | null; closedAt?: string | null; deployed: boolean };
export type Decision = { prefix: string; terminal: boolean; problem?: string };

export function decide(info: PrInfo, now: number, pr = 0, fixId = 0): Decision {
  const state = (info.state || "").toUpperCase();
  if (state === "MERGED" || info.mergedAt) {
    if (info.deployed) return { prefix: "[DEPLOYED] ", terminal: true };
    const d: Decision = { prefix: "[MERGED, not deployed yet] ", terminal: false };
    const t = info.mergedAt ? Date.parse(info.mergedAt) : NaN;
    if (!Number.isNaN(t) && now - t > TWO_HOURS) d.problem = `PR #${pr} (fix #${fixId}) is merged but not live after 2h`;
    return d;
  }
  if (state === "CLOSED") {
    return {
      prefix: "[CLOSED WITHOUT MERGE] ",
      terminal: true,
      problem: `PR #${pr} for fix #${fixId} was closed without merging; the change is not in main`,
    };
  }
  return { prefix: "[PR OPEN] ", terminal: false };
}

export type FixRow = { id: number; result: string | null };
export type GhView = {
  state: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  mergeCommit?: { oid?: string } | null;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
};

export type Deps = {
  rows: () => FixRow[];
  gh: (pr: number) => Promise<GhView>;
  isDeployed: (mergeOid: string, pr: number) => boolean;
  update: (id: number, result: string) => void;
  issue: (message: string, extra: Record<string, unknown>) => void;
  now: () => number;
  log: (msg: string) => void;
  rebuild?: (fixId: number, pr: number) => void;
};

export async function syncFixPrStatuses(deps: Deps): Promise<void> {
  let ghFailed: string | null = null;
  for (const row of deps.rows().slice(0, 20)) {
    const result = row.result || "";
    if (/^\[(DEPLOYED|CLOSED WITHOUT MERGE)/.test(result)) continue;
    const pr = prNumberFromResult(result);
    if (pr == null) continue;
    let view: GhView;
    try {
      view = await deps.gh(pr);
    } catch (e) {
      ghFailed = ghFailed || (e instanceof Error ? e.message : String(e));
      continue;
    }
    const oid = view.mergeCommit?.oid;
    const merged = String(view.state).toUpperCase() === "MERGED" || !!view.mergedAt;
    const deployed = merged && !!oid && deps.isDeployed(oid, pr);
    const d = decide({ state: view.state, mergedAt: view.mergedAt, closedAt: view.closedAt, deployed }, deps.now(), pr, row.id);
    const next = d.prefix + stripPrefix(result);
    if (next !== result) deps.update(row.id, next);
    if (d.problem) deps.issue(d.problem, { fix: row.id, pr });
    if (deps.rebuild && needsRebuild(view)) {
      try {
        deps.rebuild(row.id, pr);
      } catch (e) {
        deps.log(`fix-pr-status: rebuild queue failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (ghFailed) deps.log(`fix-pr-status: gh failed: ${ghFailed}`);
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout) });
      const code = (err as { code?: unknown }).code;
      if (typeof code === "number") return resolve({ code, stdout: String(stdout) });
      reject(err);
    });
  });
}

export async function realDeps(): Promise<Deps> {
  return realDepsWith({});
}

// Real deps with some parts (e.g. rows) overridden; gh, isDeployed, update are reused.
export async function realDepsWith(over: Partial<Deps>): Promise<Deps> {
  const { default: db } = await import("./db");
  const { bumpOpenIssue } = await import("./issue-once");
  const { liveRelease } = await import("./deploy");
  const repo = process.env.GITHUB_REPO || "";
  const root = process.env.GLOS_ROOT || "/opt/genlimitless-os";
  const base: Deps = {
    rows: () =>
      db
        .prepare(
          `SELECT id, result FROM fix_proposals
           WHERE status='sent_to_github' AND kind='github' AND created_at >= datetime('now','-30 days')
             AND COALESCE(result,'') NOT LIKE '[DEPLOYED%' AND COALESCE(result,'') NOT LIKE '[CLOSED WITHOUT MERGE%'
           ORDER BY id DESC LIMIT 20`
        )
        .all() as FixRow[],
    gh: async (pr) => {
      const r = await run("gh", ["pr", "view", String(pr), "--repo", repo, "--json", "state,mergedAt,closedAt,mergeCommit,mergeable,mergeStateStatus"]);
      if (r.code !== 0) throw new Error(`gh pr view ${pr} exited ${r.code}`);
      return JSON.parse(r.stdout) as GhView;
    },
    isDeployed: (oid, pr) => {
      try {
        const live = liveRelease();
        if (!live) throw new Error("no live release");
        // execFile is async; use the sync variant for this tiny check
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { spawnSync } = require("child_process") as typeof import("child_process");
        const r = spawnSync("git", [`--git-dir=${root}/repo.git`, "merge-base", "--is-ancestor", oid, live], { timeout: 30_000 });
        if (r.error) throw r.error;
        if (r.status === 0) return true;
        if (r.status === 1) return false;
        throw new Error(`git exited ${r.status}`);
      } catch {
        try {
          return !!db.prepare(`SELECT 1 FROM auto_merge_log WHERE pr=? AND status='deployed' LIMIT 1`).get(pr);
        } catch {
          return false;
        }
      }
    },
    update: (id, result) => {
      db.prepare("UPDATE fix_proposals SET result=? WHERE id=?").run(result, id);
    },
    issue: (message, extra) => bumpOpenIssue("fix_pr_status", message, extra),
    now: () => Date.now(),
    log: (m) => console.error(m),
    rebuild: (fixId, pr) => {
      queueRebuild(db as unknown as RebuildDb, fixId, pr);
    },
  };
  return { ...base, ...over };
}

export function startFixPrStatusWatch(): void {
  const g = globalThis as { __fixPrStatusWatch?: boolean };
  if (g.__fixPrStatusWatch || !process.env.GITHUB_REPO) return;
  g.__fixPrStatusWatch = true;
  const tick = async () => {
    try {
      await syncFixPrStatuses(await realDeps());
    } catch (e) {
      console.error("fix-pr-status tick failed", e);
    }
  };
  import("node-cron").then((m) => (m.default || m).schedule("*/5 * * * *", tick)).catch((e) => console.error("fix-pr-status cron failed", e));
  setTimeout(tick, 60_000).unref?.();
  // One-time backfill of older rows (marker file makes it a no-op afterwards); no extra cron.
  setTimeout(() => {
    import("./fix-pr-backfill")
      .then((m) => m.runPrBackfillOnce())
      .catch((e) => console.error("fix-pr-backfill failed", e));
  }, 120_000).unref?.();
}
