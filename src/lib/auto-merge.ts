import type { DeployStatus } from "./deploy";
import { BRANCH_RE, evaluatePr, type PrFile } from "./auto-merge-policy";

// Merges and deploys the OS engineer's PRs without Owner, unless src/lib/auto-merge-policy.ts holds them
// (external sends, whole-file deletes, login/security code, new packages, database changes).
//
// Every 3 minutes: (1) look at open engineer/fix-N PRs; (2) for each new head commit, run the policy and
// either merge (pinned to that exact commit, so a later push can't sneak past the check) or record a hold
// and raise an issue; (3) make sure merged PRs reach production. A deploy restarts this very process, so
// step 3 can't wait on it: progress lives in auto_merge_log and the next tick finishes the job.
//
// Off switch: create the file data/AUTO_MERGE_DISABLED (or set AUTO_MERGE=0). Nothing else needed.
// This file does no I/O of its own (see auto-merge-server.ts for the real wiring), so it is tested with fakes.

const MAX_DEPLOY_TRIES = 3;

export type LogRow = { pr: number; head_sha: string; status: "held" | "merged" | "deployed" | "deploy_failed"; reasons: string | null; deploy_tries: number };

export type Deps = {
  repo: string;
  gh: (args: string[]) => Promise<string>;
  killed: () => boolean;
  fixIsOurs: (n: number) => boolean;
  log: {
    get: (pr: number, sha: string) => LogRow | undefined;
    put: (pr: number, sha: string, status: LogRow["status"], reasons?: string[]) => void;
    awaitingDeploy: () => LogRow[];
    setStatus: (rows: LogRow[], status: LogRow["status"], addTry?: boolean) => void;
  };
  deploy: { status: () => DeployStatus | null; live: () => string | null; latest: () => Promise<string | null>; start: () => Promise<void> };
  held: (pr: number, branch: string, reasons: string[]) => void;
  note: (message: string) => void;
  problem: (message: string, extra?: Record<string, unknown>) => void;
};

async function ghJson<T>(deps: Deps, args: string[]): Promise<T> {
  return JSON.parse(await deps.gh(args)) as T;
}

async function prFiles(deps: Deps, n: number): Promise<PrFile[]> {
  // One compact JSON object per line (gh 2.46 has no --slurp), across all pages.
  const out = await deps.gh(["api", `repos/${deps.repo}/pulls/${n}/files?per_page=100`, "--paginate", "--jq", ".[] | @json"]);
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as PrFile);
}

async function considerPr(deps: Deps, n: number, branch: string): Promise<"merged" | "held" | "skipped"> {
  const pr = await ghJson<{ state: string; draft: boolean; mergeable_state: string; head: { sha: string; repo: { full_name: string } | null }; base: { repo: { full_name: string } } }>(
    deps,
    ["api", `repos/${deps.repo}/pulls/${n}`]
  );
  if (pr.state !== "open" || pr.draft) return "skipped";
  const sha = pr.head.sha;
  if (deps.log.get(n, sha)) return "skipped"; // already decided for this exact commit
  // 'clean' = mergeable and no failing checks. Anything else (behind, conflicting, checks running or failing,
  // still computing) is looked at again next tick, once the conflict watcher or CI has settled it.
  if (pr.mergeable_state !== "clean") return "skipped";

  const reasons: string[] = [];
  const m = BRANCH_RE.test(branch) ? /fix-(\d+)$/.exec(branch) : null;
  if (!m || !deps.fixIsOurs(Number(m[1]))) reasons.push("no matching approved fix proposal in the OS");
  if (pr.head.repo?.full_name !== pr.base.repo.full_name) reasons.push("branch comes from a fork");
  if (!reasons.length) reasons.push(...evaluatePr(branch, await prFiles(deps, n)).reasons);

  if (reasons.length) {
    deps.log.put(n, sha, "held", reasons);
    deps.held(n, branch, reasons);
    return "held";
  }
  // --match-head-commit: GitHub refuses if the branch moved since the policy looked at it.
  await deps.gh(["pr", "merge", String(n), "--repo", deps.repo, "--merge", "--match-head-commit", sha]);
  deps.log.put(n, sha, "merged");
  deps.note(`PR #${n} passed the auto-merge checks and was merged. Deploying it now.`);
  return "merged";
}

export async function reconcileDeploys(deps: Deps): Promise<void> {
  const rows = deps.log.awaitingDeploy();
  if (!rows.length) return;
  const latest = await deps.deploy.latest();
  if (!latest) return;
  const live = deps.deploy.live();
  const prs = rows.map((r) => `#${r.pr}`).join(", ");
  if (live && live.slice(0, 12) === latest.slice(0, 12)) {
    deps.log.setStatus(rows, "deployed");
    deps.note(`Auto-deployed ${prs}. The live version is now ${live.slice(0, 7)}.`);
    return;
  }
  if (deps.deploy.status()?.state === "running") return; // glos-deploy is mid-build; look again next tick
  if (Math.max(...rows.map((r) => r.deploy_tries)) >= MAX_DEPLOY_TRIES) {
    const st = deps.deploy.status();
    deps.log.setStatus(rows, "deploy_failed");
    deps.problem(`Auto-deploy of ${prs} didn't complete after ${MAX_DEPLOY_TRIES} tries. They are merged on GitHub but not live.`, { last_status: st?.state, message: st?.message });
    return;
  }
  deps.log.setStatus(rows, "merged", true);
  try {
    await deps.deploy.start();
  } catch (e) {
    deps.problem(`Auto-deploy of ${prs} couldn't start: ${(e as Error).message}`);
  }
}

export async function autoMergeTick(deps: Deps): Promise<{ merged: number; held: number }> {
  const out = { merged: 0, held: 0 };
  if (deps.killed()) return out;
  const prs = await ghJson<{ number: number; headRefName: string }[]>(deps, [
    "pr", "list", "--repo", deps.repo, "--state", "open", "--limit", "50", "--json", "number,headRefName",
  ]);
  for (const p of prs.filter((x) => BRANCH_RE.test(x.headRefName))) {
    try {
      const r = await considerPr(deps, p.number, p.headRefName);
      if (r === "merged") out.merged++;
      if (r === "held") out.held++;
    } catch (e) {
      deps.problem(`Auto-merge couldn't process PR #${p.number}: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  await reconcileDeploys(deps);
  return out;
}
