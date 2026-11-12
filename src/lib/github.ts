import { execFile } from "child_process";
import { MIRROR_MODE } from "./imessage";
import db, { logIssue } from "./db";
import { bumpOpenIssue } from "./issue-once";
import { resolveRepo } from "./github-repos";

// The Chief of Staff's only GitHub power: open issues and read issue/PR status on the
// OS's own repo. The actual coding happens on GitHub's servers (Claude Code GitHub app),
// never on this Mac — so nothing the agent reads on the web can run commands here.

const REPO = process.env.GITHUB_REPO; // e.g. "your-github-user-genlimitless/genlimitless-ai-os"

function gh(args: string[], repo?: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    let target: string;
    try {
      target = resolveRepo(repo);
    } catch (e) {
      return reject(e);
    }
    execFile("gh", [...args, "--repo", target], { timeout: 60_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim())
    );
  });
}

export const ENGINEERING_ISSUE_TRAILER =
  "Work on a branch and open a PR. First run `npx next typegen` (generates the Next route types such as LayoutProps; skip only if that command is not permitted, CI may already have done it), then run `npx tsc --noEmit` and fix every error. Add/extend a Playwright test in e2e/ for any bug fix. Do not edit package.json or .github/workflows/* (Owner maintains those). Never merge — Owner merges.";

/** Open an issue assigned to the Claude Code GitHub app (it opens a PR for Owner to merge). */
export async function openEngineeringIssue(title: string, body: string, repo?: string | null) {
  const url = await gh([
    "issue",
    "create",
    "--title",
    title,
    "--body",
    `@claude ${body}\n\n${ENGINEERING_ISSUE_TRAILER}`,
  ], repo);
  return { url };
}

export async function listEngineeringWork(repo?: string | null) {
  const [issues, prs] = await Promise.all([
    gh(["issue", "list", "--state", "open", "--json", "number,title,url,createdAt", "--limit", "30"], repo),
    gh(["pr", "list", "--state", "open", "--json", "number,title,url,headRefName,createdAt", "--limit", "30"], repo),
  ]);
  return { repo: repo || process.env.GITHUB_REPO, open_issues: JSON.parse(issues || "[]"), open_prs: JSON.parse(prs || "[]") };
}

/** Read-only: why a PR won't merge. */
export async function getPRStatus(number: number, repo?: string | null) {
  const raw = await gh(
    ["pr", "view", String(number), "--json", "number,title,state,isDraft,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,url"],
    repo
  );
  const p = JSON.parse(raw);
  const checks = (p.statusCheckRollup || []).map((c: any) => ({
    name: c.name || c.context,
    status: c.status || c.state,
    conclusion: c.conclusion ?? null,
  }));
  const mergeable = p.mergeable || "UNKNOWN";
  const merge_state = p.mergeStateStatus || "UNKNOWN";
  return {
    number: p.number,
    title: p.title,
    url: p.url,
    state: p.state,
    is_draft: !!p.isDraft,
    base: p.baseRefName,
    head: p.headRefName,
    mergeable,
    merge_state,
    has_conflicts: mergeable === "CONFLICTING",
    behind_base: merge_state === "BEHIND",
    review_decision: p.reviewDecision || null,
    checks,
    failing_checks: checks
      .filter((c: any) => ["FAILURE", "TIMED_OUT", "CANCELLED"].includes(c.conclusion))
      .map((c: any) => c.name),
  };
}

/** Merge the base branch into an open engineer/* PR branch (GitHub update-branch). No force-push. */
export async function updatePRBranch(number: number, repo?: string | null): Promise<{ ok: boolean; message: string }> {
  const status = await getPRStatus(number, repo);
  if (status.state !== "OPEN") throw new Error(`PR #${number} is ${status.state}, not OPEN; refusing to update it.`);
  if (!String(status.head || "").startsWith("engineer/"))
    throw new Error(`PR #${number} head branch "${status.head}" is not an engineer/* branch; refusing to update it.`);
  const target = resolveRepo(repo);
  const res = await new Promise<{ err: Error | null; out: string }>((resolve) =>
    execFile("gh", ["api", "-X", "PUT", `repos/${target}/pulls/${number}/update-branch`], { timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ err, out: `${stdout}${stderr}` })
    )
  );
  if (res.err) {
    if (/422|merge conflict/i.test(res.out) || /422|merge conflict/i.test(res.err.message)) {
      bumpOpenIssue("github", `update-branch for PR #${number} failed: merge conflict (needs rebuild on main)`, {
        gh: String(res.out || res.err.message).slice(0, 300),
      });
      const message = "conflicts must be resolved by the coding agent";
      return { ok: false, message };
    }
    throw new Error(res.out || res.err.message);
  }
  return { ok: true, message: "Update requested; checks will re-run" };
}

// ---------- Pull requests → OS chat ----------


db.exec(`
CREATE TABLE IF NOT EXISTS github_prs (
  number INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL,
  posted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
{
  const cols = db.prepare(`PRAGMA table_info(chat_history)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "meta")) db.exec(`ALTER TABLE chat_history ADD COLUMN meta TEXT`);
}

export type PRDetails = {
  number: number;
  title: string;
  url: string;
  state: string; // OPEN | MERGED | CLOSED
  body: string;
  headRefName: string;
  additions: number;
  deletions: number;
  files: { path: string; additions: number; deletions: number }[];
  checks: { name: string; status: string; conclusion: string | null }[];
  mergeable: string;
};

export async function getPR(number: number): Promise<PRDetails> {
  const raw = await gh([
    "pr",
    "view",
    String(number),
    "--json",
    "number,title,url,state,body,headRefName,additions,deletions,files,statusCheckRollup,mergeable",
  ]);
  const p = JSON.parse(raw);
  return {
    ...p,
    files: p.files || [],
    checks: (p.statusCheckRollup || []).map((c: any) => ({
      name: c.name || c.context,
      status: c.status || c.state,
      conclusion: c.conclusion ?? null,
    })),
  };
}

// Claude on GitHub pushes `claude/issue-N-…` branches but leaves the PR for a human to
// open. Open it ourselves so it can flow straight into chat.
const emptyBranches = new Set<string>();

export async function openMissingClaudePRs() {
  const res = await sh("gh", ["api", `repos/${REPO}/branches?per_page=100`, "-q", "[.[].name]"], 60_000);
  if (!res.ok) throw new Error(`Couldn't list branches for ${REPO} (check GITHUB_REPO and gh auth): ${res.out}`);
  const branches = JSON.parse(res.out || "[]");
  const openHeads = new Set(
    JSON.parse(await gh(["pr", "list", "--state", "all", "--json", "headRefName", "--limit", "100"])).map((p: any) => p.headRefName)
  );
  let firstError: unknown;
  for (const branch of branches as string[]) {
    const m = branch.match(/^claude\/issue-(\d+)-/);
    if (!m || openHeads.has(branch) || emptyBranches.has(branch)) continue;
    try {
      const issue = JSON.parse(await gh(["issue", "view", m[1], "--json", "title,comments"]));
      const summary = (issue.comments?.at(-1)?.body || "").split("### PR")[0].trim().slice(0, 4000);
      await gh(["pr", "create", "--head", branch, "--base", "main", "--title", issue.title, "--body", `Fixes #${m[1]}\n\n${summary}`]);
    } catch (e: any) {
      if (/No commits between/i.test(String(e?.message || e))) {
        emptyBranches.add(branch);
        continue;
      }
      if (firstError === undefined) firstError = e;
    }
  }
  if (firstError !== undefined) throw firstError;
}

// Dedupe/backoff so a persistent failure (e.g. wrong GITHUB_REPO → 404) doesn't log an issue every run.
const SAME_ERROR_WINDOW_MS = 6 * 60 * 60_000;
const NOT_FOUND_BACKOFF_MS = 30 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
let lastLoggedError: { message: string; at: number } | null = null;
let backoffUntil = 0;

/** Normalizes volatile parts (request ID, timestamp) so repeated identical errors dedupe. */
export function errorKey(m: string) {
  return m.replace(/request ID [0-9A-Fa-f:]+/g, "request ID X").replace(/timestamp [\d-]+ [\d:]+ UTC/g, "timestamp T").slice(0, 300);
}

export const RATE_LIMIT_RE = /rate limit|HTTP 403|HTTP 429|"status": "(403|429)"/i;

/** Runs every couple of minutes: new PRs appear in the OS chat. */
export async function syncPullRequests() {
  if (!REPO) return;
  try {
    // Backoff only pauses auto-opening Claude PRs; the notice loop below always runs.
    if (Date.now() >= backoffUntil) await openMissingClaudePRs();
  } catch (e: any) {
    const message = String(e?.message || e);
    if (/404|not found/i.test(message)) backoffUntil = Date.now() + NOT_FOUND_BACKOFF_MS;
    if (RATE_LIMIT_RE.test(message)) backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
    const now = Date.now();
    const key = errorKey(message);
    if (!lastLoggedError || lastLoggedError.message !== key || now - lastLoggedError.at > SAME_ERROR_WINDOW_MS) {
      lastLoggedError = { message: key, at: now };
      logIssue("github", message);
    }
    // Fall through: a failure auto-opening Claude PRs must never block the notices.
  }
  if (Date.now() - lastBranchCleanup > BRANCH_CLEANUP_EVERY_MS) {
    lastBranchCleanup = Date.now();
    try {
      await cleanupSupersededBranches();
    } catch (e: any) {
      logIssue("github", `Superseded branch cleanup failed: ${String(e?.message || e)}`);
    }
  }
  const open = JSON.parse(await gh(["pr", "list", "--state", "open", "--json", "number,title,url", "--limit", "30"])) as {
    number: number;
    title: string;
    url: string;
  }[];
  for (const pr of open) {
    const seen = db.prepare(`SELECT 1 FROM github_prs WHERE number=?`).get(pr.number);
    if (seen) continue;
    db.transaction(() => {
      db.prepare(`INSERT INTO github_prs (number, title, url, state) VALUES (?, ?, ?, 'OPEN')`).run(pr.number, pr.title, pr.url);
      db.prepare(`INSERT INTO chat_history (role, content, meta) VALUES ('assistant', ?, ?)`).run(
        `**New pull request #${pr.number}:** ${pr.title}`,
        JSON.stringify({ type: "pr", number: pr.number })
      );
    })();
  }
}

function sh(cmd: string, args: string[], timeout = 10 * 60_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { cwd: process.cwd(), timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}` })
    )
  );
}

/** Owner clicked Merge: merge on GitHub, pull onto this Mac, install deps, re-run the UI checks. */
export async function mergePR(number: number): Promise<{ ok: boolean; message: string }> {
  const head = await headOf(number);
  await gh(["pr", "merge", String(number), "--squash"]);
  db.prepare(`UPDATE github_prs SET state='MERGED' WHERE number=?`).run(number);
  if (head) await deleteBranchSafe(head);

  // On the server, merging only merges. Going live is a separate, confirmed Deploy (see lib/deploy.ts).
  if (MIRROR_MODE) {
    return { ok: true, message: `Merged #${number} on GitHub. The server is still running the old version until you click Deploy.` };
  }

  const before = (await sh("git", ["rev-parse", "HEAD"])).out.trim();
  const pull = await sh("git", ["pull", "--ff-only", "--autostash"]);
  if (!pull.ok) {
    const msg = `Merged #${number} on GitHub, but couldn't pull it onto this Mac (local changes are in the way): ${pull.out.slice(-400)}`;
    logIssue("github", msg);
    return { ok: false, message: msg };
  }
  const changed = (await sh("git", ["diff", "--name-only", before, "HEAD"])).out;
  if (/package(-lock)?\.json/.test(changed)) await sh("npm", ["install"]);

  const { runE2E } = await import("./selftest");
  await new Promise((r) => setTimeout(r, 4000)); // let the dev server hot-reload
  const tests = await runE2E();
  const needsRestart = /src\/(instrumentation|lib\/scheduler)\.ts/.test(changed);
  const message =
    `Merged #${number} and pulled it onto this Mac — it's live. ` +
    (tests.ok ? `All ${tests.passed} UI checks pass.` : `⚠️ UI checks failing: ${tests.failed.join("; ")}`) +
    (needsRestart ? " Scheduler code changed, so restart the server for that part to take effect." : "");
  if (!tests.ok) logIssue("github", `UI checks failing after merging #${number}`, tests.failed);
  return { ok: tests.ok, message };
}

export async function closePR(number: number) {
  const head = await headOf(number);
  await gh(["pr", "close", String(number)]);
  db.prepare(`UPDATE github_prs SET state='CLOSED' WHERE number=?`).run(number);
  if (head) await deleteBranchSafe(head);
}

async function headOf(number: number): Promise<string | null> {
  try {
    return (await getPR(number)).headRefName || null;
  } catch {
    return null;
  }
}

/** Best-effort delete of an engineer/fix-N branch. Never throws; unknown failures are logged with the exact stderr. */
export async function deleteBranchSafe(headRefName: string): Promise<void> {
  if (!/^engineer\/fix-\d+$/.test(headRefName)) return;
  if (Date.now() < backoffUntil) return;
  const res = await sh("gh", ["api", "-X", "DELETE", `repos/${REPO}/git/refs/heads/${headRefName}`], 60_000);
  if (res.ok) return;
  if (/Reference does not exist|404|422|Not Found/i.test(res.out)) return;
  if (RATE_LIMIT_RE.test(res.out)) backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
  logIssue("github", `Branch delete failed for ${headRefName}: ${res.out}`);
}

let lastBranchCleanup = 0;
const BRANCH_CLEANUP_EVERY_MS = 6 * 60 * 60_000;

/** Delete branches of open PRs marked "[auto] Superseded" whose rebuild proposal is applied/merged. Never closes the PR. */
export async function cleanupSupersededBranches(): Promise<void> {
  if (Date.now() < backoffUntil) return;
  const prs = JSON.parse(
    await gh(["pr", "list", "--state", "open", "--json", "number,headRefName,comments", "--limit", "30"])
  ) as { number: number; headRefName: string; comments?: { body: string }[] }[];
  for (const p of prs) {
    const last = p.comments?.at(-1)?.body || "";
    if (!last.startsWith("[auto] Superseded")) continue;
    const m = /fix proposal #(\d+)/.exec(last);
    if (!m) continue;
    const row = db.prepare(`SELECT status FROM fix_proposals WHERE id=?`).get(Number(m[1])) as { status: string } | undefined;
    if (!row || !["applied", "merged"].includes(row.status)) continue;
    await deleteBranchSafe(p.headRefName);
  }
}
