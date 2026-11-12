import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execFile } from "child_process";
import db from "../db";
import { withAudit } from "../audit";
import { getFixProposal } from "./fixes";
import { logActivity } from "./registry";
import { checkPr, mergePr, ENGINEER_BRANCH_RE, type MergeDeps, type MergeResult } from "../pr-merge";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: (e as Error).message }], isError: true });
const AS_AGENT = { as_agent: z.string().optional().describe("Filled in automatically. Leave empty.") };

let ready = false;
function init() {
  if (ready) return;
  db.exec(`
CREATE TABLE IF NOT EXISTS pr_merge_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr INTEGER NOT NULL, proposal_id INTEGER, head_sha TEXT,
  outcome TEXT NOT NULL,            -- merged | refused
  reasons TEXT,                     -- JSON array for refusals
  by_agent TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pr_merge_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
  ready = true;
}

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("gh", args, { timeout: 90_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim())
    )
  );
}

export function mergeEnabled(): boolean {
  init();
  if (process.env.PR_MERGE === "0") return false;
  const r = db.prepare(`SELECT value FROM pr_merge_settings WHERE key='enabled'`).get() as { value: string } | undefined;
  return r?.value !== "0";
}

export function realDeps(): MergeDeps {
  const repo = process.env.GITHUB_REPO;
  if (!repo) throw new Error("GITHUB_REPO is not set");
  return {
    repo, gh, enabled: mergeEnabled,
    proposal: (id) => { const p = getFixProposal(id); return p ? { id: p.id, kind: p.kind, status: p.status } : undefined; },
  };
}

const inFlight = new Set<number>();

/** Merge + log + activity + one-line chat note. Exported so tests can inject fake deps. */
export async function mergeWith(deps: MergeDeps, n: number, by: string): Promise<MergeResult> {
  init();
  if (inFlight.has(n)) throw new Error(`PR #${n} is already being merged`);
  inFlight.add(n);
  try {
    const r = await mergePr(deps, n);
    db.prepare(`INSERT INTO pr_merge_log (pr, proposal_id, head_sha, outcome, reasons, by_agent) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(n, r.proposal_id, r.head_sha, r.merged ? "merged" : "refused", r.merged ? null : JSON.stringify(r.reasons), by);
    if (r.merged) {
      try { db.prepare(`UPDATE github_prs SET state='MERGED' WHERE number=?`).run(n); } catch { /* table is created by github.ts; best-effort */ }
      logActivity(by, "pr_merge", `Squash-merged PR #${n} (fix #${r.proposal_id}, approved by Owner) at ${String(r.head_sha).slice(0, 7)}. Not deployed.`);
      db.prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant', ?)`)
        .run(`Chief of Staff merged PR #${n} (fix #${r.proposal_id}, approved by Owner). It is merged on GitHub only; not live until deployed.`);
    }
    return r;
  } finally {
    inFlight.delete(n);
  }
}

const audited = <T,>(by: string, fn: () => Promise<T>) => withAudit(`agent:${by}`, undefined, fn);
const cosOnly = (by: string) => { if (by !== "chief_of_staff") throw new Error("Only the Chief of Staff can merge PRs or change the merge switch."); };

export const prMergeTools = [
  tool(
    "merge_pr",
    "Chief of Staff only. Squash-merge ONE open engineer/fix-N PR on GitHub, but only if ALL are true: proposal #N is accepted (sent_to_github/applied) AND the PR itself records that Owner approved it; GitHub says MERGEABLE and CLEAN; no check failing or running; merging is switched on. Otherwise it merges nothing and returns every reason. Never force-pushes, never deletes a branch or file, never deploys (deploy is a separate step; merge 'Users tab' PRs in order and deploy them together). Logs to the activity feed and posts one line in chat. A merge cannot be undone with this tool; a revert goes through a normal fix proposal.",
    { number: z.number().int().positive(), ...AS_AGENT },
    async ({ number, as_agent }: { number: number; as_agent?: string }) => {
      try {
        const by = as_agent || "agent";
        cosOnly(by);
        return json(await audited(by, () => mergeWith(realDeps(), number, by)));
      } catch (e) { return fail(e); }
    }
  ),
  tool(
    "list_pr_merges",
    "Read-only. Every open engineer/fix-N PR with whether merge_pr would merge it right now (ready) or the exact reasons it would refuse, whether merging is switched on, and the last 30 merge attempts (merged and refused).",
    { ...AS_AGENT },
    async ({ as_agent }: { as_agent?: string }) => {
      try {
        return json(await audited(as_agent || "agent", async () => {
          init();
          const deps = realDeps();
          const open = JSON.parse(await gh(["pr", "list", "--repo", deps.repo, "--state", "open", "--limit", "30", "--json", "number,headRefName"])) as { number: number; headRefName: string }[];
          const prs = [];
          for (const p of open.filter((x) => ENGINEER_BRANCH_RE.test(x.headRefName))) {
            const c = await checkPr(deps, p.number);
            prs.push({ pr: c.pr, title: c.title, proposal_id: c.proposal_id, ready: c.reasons.length === 0, reasons: c.reasons });
          }
          const recent = db.prepare(`SELECT * FROM pr_merge_log ORDER BY id DESC LIMIT 30`).all();
          return { enabled: mergeEnabled(), prs, recent };
        }));
      } catch (e) { return fail(e); }
    },
    { annotations: { readOnlyHint: true } }
  ),
  tool(
    "set_pr_merge_enabled",
    "Chief of Staff only. Switch merge_pr off (enabled=false) or back on. While off, merge_pr refuses everything. Needs a reason (logged). Changes only this switch.",
    { enabled: z.boolean(), reason: z.string().min(5), ...AS_AGENT },
    async ({ enabled, reason, as_agent }: { enabled: boolean; reason: string; as_agent?: string }) => {
      try {
        const by = as_agent || "agent";
        cosOnly(by);
        return json(await audited(by, async () => {
          init();
          db.prepare(`INSERT INTO pr_merge_settings (key, value, updated_by) VALUES ('enabled', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=datetime('now')`).run(enabled ? "1" : "0", by);
          logActivity(by, "pr_merge", `PR merging switched ${enabled ? "on" : "off"}: ${reason.trim()}`);
          return { enabled: mergeEnabled() };
        }));
      } catch (e) { return fail(e); }
    }
  ),
];
