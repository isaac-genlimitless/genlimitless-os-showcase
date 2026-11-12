import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs";
import path from "path";
import db, { logIssue } from "./db";
import { logIssueOnce } from "./issue-once";
import { runE2E } from "./selftest";
import { CODE_WRITE_DENY, LOCKED_BASE, SECRET_READ_DENY } from "./agent-lock";
import { execFile } from "child_process";
import { FixProposal, effectiveFixKind, getFixProposal } from "./agents/fixes";
import { openEngineeringIssue } from "./github";
import { MIRROR_MODE } from "./imessage";
import { buildPullRequest } from "./pr-builder";
import { CORE_AGENTS } from "./agents/charters";

// Applying the Full Stack Engineer's approved changes. Who may approve what:
//   Chief of Staff: minor, local changes it reviewed (status cos_approved)
//   Owner:          anything pending (major ones only ever reach "applying" through him)
// Every application is checked afterwards and rolled back if it deleted or gutted a file,
// needs an unapproved new package, doesn't type-check, or breaks the UI tests.

export { proposeFix } from "./agents/fixes";

const MODEL = "claude-sonnet-5-5";

function sh(cmd: string, args: string[], timeout = 5 * 60_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { cwd: process.cwd(), timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}` })
    )
  );
}

// The editing agent can't run a shell, so it can add an import it can't install.
async function typecheck(): Promise<{ ok: boolean; out: string; missing: string[] }> {
  const tsc = await sh("npx", ["tsc", "--noEmit", "-p", "."]);
  const missing = [
    ...new Set(
      [...tsc.out.matchAll(/Cannot find module '([^'.][^']*)'/g)]
        .map((m) => m[1])
        .filter((name) => !name.startsWith("@/"))
        .map((name) => (name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]))
    ),
  ];
  return { ok: tsc.ok, out: tsc.out, missing };
}

/** Paths git reports as changed right now (other sessions may have work in progress, so we diff before/after). */
async function dirtyPaths(): Promise<Map<string, string>> {
  const r = await sh("git", ["status", "--porcelain", "--untracked-files=all"]);
  const m = new Map<string, string>();
  for (const line of r.out.split("\n")) {
    if (line.length < 4) continue;
    m.set(line.slice(3).replace(/^"|"$/g, ""), line.slice(0, 2));
  }
  return m;
}

type Snapshot = { before: Map<string, string>; contents: Map<string, string | null> };

async function snapshot(files: string[]): Promise<Snapshot> {
  const before = await dirtyPaths();
  const contents = new Map<string, string | null>();
  for (const f of files) {
    const abs = path.join(process.cwd(), f);
    contents.set(f, fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null);
  }
  return { before, contents };
}

/** Files this application changed, and whether any were deleted or gutted. */
async function inspectChanges(snap: Snapshot) {
  const after = await dirtyPaths();
  const changed = new Set<string>();
  for (const [p, code] of after) if (snap.before.get(p) !== code) changed.add(p);
  for (const [f, was] of snap.contents) {
    const abs = path.join(process.cwd(), f);
    const now = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    if (now !== was) changed.add(f);
  }
  const violations: string[] = [];
  for (const f of changed) {
    const abs = path.join(process.cwd(), f);
    if (!fs.existsSync(abs)) {
      violations.push(`${f} was deleted`);
      continue;
    }
    const was = snap.contents.get(f);
    if (!was) continue;
    const now = fs.readFileSync(abs, "utf8");
    const wasLines = was.split("\n").length;
    if (now.trim() === "") violations.push(`${f} was emptied`);
    else if (wasLines > 40 && now.split("\n").length < wasLines * 0.2) violations.push(`${f} was mostly removed`);
  }
  return { changed: [...changed], violations };
}

/**
 * Put every file this application touched back the way it was. Never deletes: a file the change
 * created is moved to data/backups/rolled-back/fix-<id>/ so it can't break the next fix's checks
 * (a leftover test importing code that was rolled back fails every later type-check).
 */
async function rollback(id: number, snap: Snapshot, changed: string[]) {
  const leftBehind: string[] = [];
  const after = await dirtyPaths();
  for (const f of changed) {
    const abs = path.join(process.cwd(), f);
    const was = snap.contents.get(f);
    const createdByUs = was === null || (!snap.contents.has(f) && !snap.before.has(f) && after.get(f) === "??");
    if (typeof was === "string") {
      fs.writeFileSync(abs, was, "utf8");
    } else if (createdByUs) {
      if (!fs.existsSync(abs)) continue;
      const dest = path.join(process.cwd(), "data", "backups", "rolled-back", `fix-${id}`, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(abs, dest);
    } else if (!snap.contents.has(f) && !snap.before.has(f)) {
      // It was clean before, so HEAD is exactly its pre-change state.
      const r = await sh("git", ["checkout", "--", f]);
      if (!r.ok) leftBehind.push(f);
    } else {
      leftBehind.push(f);
    }
  }
  return leftBehind;
}

function finish(id: number, status: string, result: string) {
  db.prepare(`UPDATE fix_proposals SET status=?, result=? WHERE id=?`).run(status, result, id);
}

/** Chief of Staff's review. Minor + approved is applied right away; major goes on to Owner. */
/** Redact anything resembling a token/key/secret value. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(gh[opusr]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,})/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, "[REDACTED]")
    .replace(
      /^(\s*(?:export\s+)?[A-Za-z0-9_.-]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_.-]*\s*[=:]).*$/gim,
      "$1 [REDACTED]",
    );
}

function runFixed(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) resolve(`not inspected: ${(stderr || err.message).toString().split("\n")[0]}`);
      else resolve(String(stdout).trimEnd() || "(no output)");
    });
  });
}

/** Read-only server config snapshot. Fixed commands, no caller args, no writes, no network. */
export async function securitySnapshot(): Promise<string> {
  const out: string[] = [];
  out.push("## Listening TCP ports (ss -ltnH)");
  out.push(await runFixed("ss", ["-ltnH"]));

  out.push("## Permissions (stat)");
  const paths = [
    "/opt/genlimitless-os",
    "/opt/genlimitless-os/shared",
    "/opt/genlimitless-os/shared/data",
    "/opt/genlimitless-os/shared/.env.local",
    "/opt/genlimitless-os/backups",
  ];
  for (const p of paths) out.push(await runFixed("stat", ["-c", "%A %U:%G %n", p]));

  out.push("## GitHub CLI auth scopes (gh auth status)");
  const gh = await new Promise<string>((resolve) => {
    execFile("gh", ["auth", "status"], { timeout: 10000 }, (err, stdout, stderr) => {
      const text = `${stdout || ""}\n${stderr || ""}`;
      const lines = text
        .split("\n")
        .filter((l) => /scopes/i.test(l))
        .map((l) => l.trim());
      resolve(lines.length ? lines.join("\n") : `not inspected: ${err ? "gh unavailable or not authenticated" : "no scopes line"}`);
    });
  });
  out.push(gh);

  out.push("## nginx site config (/etc/nginx/sites-enabled/glos-os)");
  try {
    out.push(fs.readFileSync("/etc/nginx/sites-enabled/glos-os", "utf8").trimEnd());
  } catch {
    out.push("not inspected: file not readable");
  }

  out.push("## ufw status");
  out.push("needs root: not inspected");
  out.push("## sshd -T");
  out.push("needs root: not inspected");

  return redactSecrets(out.join("\n"));
}

export async function reviewFixProposal(id: number, decision: "approve" | "send_back" | "reject", notes: string) {
  const p = getFixProposal(id);
  if (!p) throw new Error(`No proposal ${id}`);
  if (p.status !== "pending_cos_review") throw new Error(`Proposal ${id} is ${p.status}, not awaiting your review`);
  const review = `[Chief of Staff: ${decision}] ${notes}`;
  if (decision === "reject") {
    db.prepare(`UPDATE fix_proposals SET status='dismissed', cos_review=? WHERE id=?`).run(review, id);
    return { proposal_id: id, status: "dismissed" };
  }
  if (decision === "send_back") {
    db.prepare(`UPDATE fix_proposals SET status='sent_back', cos_review=? WHERE id=?`).run(review, id);
    return {
      proposal_id: id,
      status: "sent_back",
      next: "Delegate to full_stack_engineer to revise it (propose_fix with revises_proposal_id).",
    };
  }
  if (p.size !== "minor") {
    db.prepare(`UPDATE fix_proposals SET status='pending_approval', cos_review=? WHERE id=?`).run(review, id);
    return {
      proposal_id: id,
      status: "pending_approval",
      note: `Major change (${p.size_reasons || "major"}): now waiting for Owner under Settings → Proposed fixes. Tell him in one line.`,
    };
  }
  db.prepare(`UPDATE fix_proposals SET status='cos_approved', cos_review=? WHERE id=?`).run(review, id);
  applyFixProposal(id, "chief_of_staff").catch((e) => logIssue("fix_proposal", `Applying fix #${id} crashed`, e.message));
  return {
    proposal_id: id,
    status: "applying",
    note: "Minor change: being applied, type-checked and tested now. list_fix_proposals shows the result.",
  };
}

// One application at a time: they share this working tree, the type-check and the e2e report file,
// so parallel ones roll back each other's files and read each other's test results.
const lock = globalThis as unknown as { __fixQueue?: Promise<unknown>; __fixRunningId?: number };

function tscErrors(out: string) {
  return new Set(out.split("\n").filter((l) => /error TS\d+/.test(l)).map((l) => l.trim()));
}

/** Apply an approved proposal. Owner may approve anything pending; the CoS only minor ones it approved. */
export async function applyFixProposal(id: number, approvedBy: "owner" | "chief_of_staff" = "owner") {
  const p = getFixProposal(id);
  if (!p) throw new Error("Proposal not found");
  const allowed =
    approvedBy === "owner"
      ? ["pending_approval", "pending_cos_review", "sent_back"].includes(p.status)
      : p.status === "cos_approved" && p.size === "minor";
  if (!allowed) throw new Error(`Proposal is ${p.status}; ${approvedBy === "owner" ? "Owner" : "the Chief of Staff"} can't apply it`);
  const busyWith = lock.__fixRunningId;
  if (busyWith && busyWith !== id) {
    db.prepare(`UPDATE fix_proposals SET status='applying', result=? WHERE id=?`).run(`Queued behind fix #${busyWith}`, id);
  } else {
    db.prepare(`UPDATE fix_proposals SET status='applying' WHERE id=?`).run(id);
  }
  const run = (lock.__fixQueue ?? Promise.resolve()).catch(() => {}).then(async () => {
    lock.__fixRunningId = id;
    db.prepare(`UPDATE fix_proposals SET result=NULL WHERE id=? AND status='applying'`).run(id);
    try {
      return await applyNow(id, approvedBy);
    } finally {
      if (lock.__fixRunningId === id) lock.__fixRunningId = undefined;
    }
  });
  lock.__fixQueue = run.catch(() => {});
  return run;
}

const BUILD_TIMEOUT_MS = 15 * 60_000;

async function applyNow(id: number, approvedBy: "owner" | "chief_of_staff") {
  const p = getFixProposal(id)!;
  // On the server nothing is edited in place: build the change on a branch of a throwaway clone and open a PR.
  if (MIRROR_MODE) return buildPullRequest(p, approvedBy);
  if (effectiveFixKind(p.kind) === "github") return sendToGithub(p);

  const files: string[] = p.files ? JSON.parse(p.files) : [];
  const snap = await snapshot(files);
  const baselineErrors = tscErrors((await typecheck()).out); // already broken before this change: not its fault
  const approver = approvedBy === "owner" ? "Owner" : "the Chief of Staff";

  const prompt = `${CORE_AGENTS.full_stack_engineer.hard}

You are now in BUILD MODE: ${approver} approved this change. Apply exactly this change, nothing broader. Follow CLAUDE.md. Do not delete or empty any file. You can't run npm; if you import a new package, just import it (only a change Owner approved may add packages). If the fix is for a UI bug, also add a Playwright test in e2e/ that would have caught it (tests must never press Send or trigger an agent).

Title: ${p.title}
Diagnosis: ${p.diagnosis}
Change: ${p.proposed_change}
Files: ${p.files}
${p.cos_review ? `Review notes: ${p.cos_review}` : ""}

Reply with a 1-3 sentence summary of what you changed.`;

  let summary = "";
  const fail = async (why: string, detail?: string) => {
    const { changed } = await inspectChanges(snap);
    const left = await rollback(id, snap, changed);
    const leftNote = left.length ? `\n\nCouldn't restore automatically (left as-is for Owner to look at): ${left.join(", ")}` : "";
    finish(id, "failed", `${summary}\n\n${why} All changes were rolled back.${detail ? `\n\n${detail}` : ""}${leftNote}`);
    logIssue("fix_proposal", `Fix #${id} rolled back: ${why}`, detail);
  };

  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, BUILD_TIMEOUT_MS);

  try {
    const result = query({
      prompt,
      options: {
        abortController,
        model: MODEL,
        cwd: process.cwd(),
        ...LOCKED_BASE,
        tools: ["Read", "Grep", "Glob", "Edit", "Write"],
        allowedTools: ["Read", "Grep", "Glob", "Edit", "Write"],
        disallowedTools: ["Bash", "Task", "Agent", "WebSearch", "WebFetch", ...SECRET_READ_DENY, ...CODE_WRITE_DENY],
        maxTurns: 40,
      },
    });
    try {
      for await (const m of result) {
        if (m.type === "result") summary = m.subtype === "success" ? m.result : `Stopped early: ${m.subtype}`;
      }
    } catch (e) {
      if (!timedOut) throw e;
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) return fail(`The build step ran longer than ${BUILD_TIMEOUT_MS / 60_000} minutes and was stopped.`);

    const { violations } = await inspectChanges(snap);
    if (violations.length)
      return fail(`The change deleted or gutted files (${violations.join("; ")}), which needs Owner's express permission.`);

    let tc = await typecheck();
    let installedNote = "";
    if (tc.missing.length) {
      if (approvedBy !== "owner") return fail(`It needs new packages (${tc.missing.join(", ")}), which only Owner can approve.`);
      const install = await sh("npm", ["install", ...tc.missing]);
      if (!install.ok) return fail(`npm install ${tc.missing.join(" ")} failed.`, install.out.slice(-1500));
      installedNote = `\n\nInstalled packages: ${tc.missing.join(", ")}.`;
      tc = await typecheck();
    }
    const newErrors = [...tscErrors(tc.out)].filter((e) => !baselineErrors.has(e));
    if (!tc.ok && (newErrors.length || !baselineErrors.size))
      return fail("The code didn't type-check after the change.", (newErrors.join("\n") || tc.out).slice(0, 3000));
    const tscNote = tc.ok ? "Type-check passes" : `Type-check has only the ${baselineErrors.size} error(s) that were there before this change`;

    await new Promise((r) => setTimeout(r, 4000)); // let the dev server recompile
    const tests = await runE2E();
    let testNote = `all ${tests.passed} UI checks pass`;
    if (!tests.ok) {
      const preexisting = await failingWithoutChange(id, snap, tests.failed);
      if (!preexisting) return fail("UI checks failed after the change.", tests.failed.join("; "));
      testNote = `${tests.passed} UI checks pass; ${tests.failed.length} were already failing without this change (${tests.failed.join("; ")})`;
      logIssueOnce("selftest:e2e", `Pre-existing failing UI check(s): ${[...tests.failed].sort().join("; ")}`,`Seen while applying fix #${id}; it fails with or without that change.`);
    }

    const { changed } = await inspectChanges(snap);
    finish(
      id,
      "applied",
      `${summary}${installedNote}\n\nChanged: ${changed.join(", ") || "(none)"}. ${tscNote} and ${testNote}. Approved by ${approver}.`
    );
    if (p.issue_id) db.prepare(`UPDATE issues SET status='resolved', resolved_at=datetime('now') WHERE id=?`).run(p.issue_id);
  } catch (e: any) {
    clearTimeout(timer);
    await fail(`Applying crashed: ${e.message}.`);
  }
}

/**
 * Were these failures already there? Takes the change out, re-runs just the failing spec files,
 * then puts the change back. True only if every one of them still fails without the change.
 */
async function failingWithoutChange(id: number, snap: Snapshot, failed: string[]) {
  if (failed.some((t) => !/\.spec\.ts/.test(t))) return false; // e.g. "could not read test report"
  const { changed } = await inspectChanges(snap);
  const applied = new Map(changed.map((f) => {
    const abs = path.join(process.cwd(), f);
    return [f, fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null] as const;
  }));
  await rollback(id, snap, changed);
  await new Promise((r) => setTimeout(r, 4000));
  const specs = [...new Set(failed.map((t) => t.split(" › ")[0]))];
  const again = await runE2E(specs);
  for (const [f, text] of applied) {
    if (text === null) continue;
    const abs = path.join(process.cwd(), f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  }
  await new Promise((r) => setTimeout(r, 4000));
  return failed.every((t) => again.failed.includes(t));
}

async function sendToGithub(p: FixProposal) {
  try {
    const { url } = await openEngineeringIssue(
      p.title,
      `${p.diagnosis}\n\n## Change\n${p.proposed_change}\n\n## Files\n${p.files}\n\n${
        p.cos_review ? `## Review notes\n${p.cos_review}\n\n` : ""
      }Do not delete any file or feature.`,
      p.repo
    );
    finish(
      p.id,
      "sent_to_github",
      `Opened ${url}. The PR it produces still needs Owner's merge.`
    );
  } catch (e: any) {
    finish(p.id, "failed", `Couldn't open the GitHub issue: ${e.message}`);
  }
}
