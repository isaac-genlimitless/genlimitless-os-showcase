// Squash-merges an engineer PR ONLY when: it is an open engineer/fix-N PR from this repo into main, proposal #N is
// accepted (sent_to_github/applied) AND the PR's last body line says Owner approved it, GitHub says MERGEABLE+CLEAN, no check
// failing or pending, and the switch is on. Never force, never --admin/--auto, never deletes a branch. Pure: tested with fakes.
export const ENGINEER_BRANCH_RE = /^engineer\/fix-(\d+)$/;
const ACCEPTED = new Set(["sent_to_github", "applied"]);
const OK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export type Proposal = { id: number; kind: string; status: string };
export type MergeDeps = {
  repo: string;
  gh: (args: string[]) => Promise<string>;
  enabled: () => boolean;
  proposal: (id: number) => Proposal | undefined;
};
export type PrCheck = { pr: number; title: string; reasons: string[]; head_sha: string | null; proposal_id: number | null };
export type MergeResult = PrCheck & { merged: boolean };
type Rollup = { name?: string; context?: string; status?: string; state?: string; conclusion?: string | null };

export function checkState(c: Rollup): "ok" | "failing" | "pending" {
  if (c.context !== undefined || (c.state && !c.status)) {
    if (c.state === "SUCCESS") return "ok";
    return c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "failing";
  }
  if (c.status !== "COMPLETED") return "pending";
  return OK_CONCLUSIONS.has(String(c.conclusion)) ? "ok" : "failing";
}

/** pr-builder.ts writes this as the LAST line of every PR body. Only the last line counts: the body above it holds the engineer's free text. */
export function approvedByOwnerFooter(body: string | null | undefined, id: number): boolean {
  const lines = String(body ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.at(-1) ?? "").startsWith(`Built by the OS engineer on the server (fix #${id}), approved by Owner.`);
}

export async function checkPr(deps: MergeDeps, n: number): Promise<PrCheck> {
  const p = JSON.parse(
    await deps.gh(["pr", "view", String(n), "--repo", deps.repo, "--json",
      "number,title,state,isDraft,headRefName,baseRefName,headRefOid,isCrossRepository,mergeable,mergeStateStatus,statusCheckRollup,body"])
  );
  const reasons: string[] = [];
  const m = ENGINEER_BRANCH_RE.exec(String(p.headRefName || ""));
  const id = m ? Number(m[1]) : null;
  if (!deps.enabled()) reasons.push("PR merging is switched off (set_pr_merge_enabled)");
  if (p.state !== "OPEN") reasons.push(`PR is ${p.state}, not OPEN`);
  if (p.isDraft) reasons.push("PR is a draft");
  if (p.baseRefName !== "main") reasons.push(`base is "${p.baseRefName}", not main`);
  if (!m) reasons.push(`branch "${p.headRefName}" is not an engineer/fix-N branch`);
  if (p.isCrossRepository) reasons.push("branch comes from a fork");
  if (id !== null) {
    const prop = deps.proposal(id);
    if (!prop) reasons.push(`no fix proposal #${id} in the OS`);
    else {
      if (prop.kind !== "github") reasons.push(`proposal #${id} is kind "${prop.kind}", not github`);
      if (!ACCEPTED.has(prop.status)) reasons.push(`proposal #${id} is ${prop.status}, not accepted (sent_to_github/applied)`);
    }
    if (!approvedByOwnerFooter(p.body, id)) reasons.push(`the PR does not record that Owner approved fix #${id} (last line must read "(fix #${id}), approved by Owner.")`);
  }
  if (p.mergeable !== "MERGEABLE") reasons.push(`GitHub says mergeable=${p.mergeable}${p.mergeable === "CONFLICTING" ? " (conflicts: the coding agent must rebuild)" : ""}`);
  if (p.mergeStateStatus !== "CLEAN") reasons.push(`merge state is ${p.mergeStateStatus}${p.mergeStateStatus === "BEHIND" ? " (run update_pr_branch first)" : ""}, not CLEAN`);
  const states = ((p.statusCheckRollup || []) as Rollup[]).map((c) => ({ name: c.name || c.context || "check", s: checkState(c) }));
  const failing = states.filter((c) => c.s === "failing").map((c) => c.name);
  const pending = states.filter((c) => c.s === "pending").map((c) => c.name);
  if (failing.length) reasons.push(`checks failing: ${failing.join(", ")}`);
  if (pending.length) reasons.push(`checks still running: ${pending.join(", ")}`);
  return { pr: n, title: String(p.title || ""), reasons, head_sha: p.headRefOid || null, proposal_id: id };
}

export async function mergePr(deps: MergeDeps, n: number): Promise<MergeResult> {
  const c = await checkPr(deps, n);
  if (c.reasons.length || !c.head_sha) return { ...c, merged: false };
  // --match-head-commit: GitHub refuses if the branch moved after we looked. No --admin, --auto, --delete-branch or force.
  await deps.gh(["pr", "merge", String(n), "--repo", deps.repo, "--squash", "--match-head-commit", c.head_sha]);
  return { ...c, merged: true };
}
