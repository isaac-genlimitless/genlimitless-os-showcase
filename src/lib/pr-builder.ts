import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import db, { logIssue } from "./db";
import { CODE_WRITE_DENY, LOCKED_BASE, SECRET_READ_DENY } from "./agent-lock";
import { CORE_AGENTS } from "./agents/charters";
import type { FixProposal } from "./agents/fixes";
import { classifyFailure, type FailKind } from "./fix-retry";
import { removeCleanupFiles } from "./cleanup-apply";
import { parseDeclaredParents, evaluateParents, waitingMessage, mergedNote, inferParentsFromFiles, inferParentsFromErrors, realDeps, type Parent } from "./fix-deps";
import { findStrays, findListedStrays } from "./stray-files";

// Server mode: the engineer builds an approved change in a throwaway clone of the repo, never in the
// live release folder (a production build, so in-place edits do nothing and vanish on the next deploy).
// Flow: clone main -> agent edits the clone -> type-check -> commit -> push a branch -> open a PR.
// Owner then merges and clicks Deploy. The live server and its data are never touched.

const ROOT = process.env.GLOS_ROOT || "/opt/genlimitless-os";
const REPO = process.env.GITHUB_REPO;
const GIT_DIR = path.join(ROOT, "repo.git");
const WORK_ROOT = path.join(ROOT, "work");
const MODEL = "claude-sonnet-5-5";
const BUILD_TIMEOUT_MS = 15 * 60_000;

// The agent's allow/deny rules are relative to its working folder, so the server's own folders (data,
// secrets, other releases, the gh login) need explicit absolute denies.
const SERVER_DIRS = ["shared", "mirror", "backups", "repo.git", "releases", ".config", ".claude", ".ssh", ".npm"];
const SERVER_DENY = SERVER_DIRS.flatMap((d) => [`Read(/${ROOT}/${d}/**)`, `Edit(/${ROOT}/${d}/**)`, `Write(/${ROOT}/${d}/**)`]);

function run(cmd: string, args: string[], cwd: string, timeout = 5 * 60_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { cwd, timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}` })
    )
  );
}

/** Paths from `git status --porcelain`, split into everything changed and the deleted ones. */
export function parsePorcelain(out: string): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3).replace(/^"|"$/g, "");
    changed.push(file);
    if (code.includes("D")) deleted.push(file);
  }
  return { changed, deleted };
}

function tscErrors(out: string) {
  return new Set(out.split("\n").filter((l) => /error TS\d+/.test(l)).map((l) => l.trim()));
}

async function typecheck(dir: string) {
  const r = await run(path.join(dir, "node_modules/.bin/tsc"), ["--noEmit", "-p", "."], dir, 10 * 60_000);
  const missing = [...r.out.matchAll(/Cannot find module '([^'.][^']*)'/g)]
    .map((m) => m[1])
    .filter((n) => !n.startsWith("@/"));
  return { ok: r.ok, out: r.out, missing: [...new Set(missing)] };
}

function finish(id: number, status: string, result: string, failKind: FailKind | null = null, retryAfter: string | null = null) {
  db.prepare(`UPDATE fix_proposals SET status=?, result=?, fail_kind=?, retry_after=? WHERE id=?`).run(status, result, failKind, retryAfter, id);
}

export async function buildPullRequest(p: FixProposal, approvedBy: "owner" | "chief_of_staff"): Promise<void> {
  if (!REPO) return finish(p.id, "failed", "GITHUB_REPO isn't set, so there's nowhere to open the PR.");
  const dep = /REQUIRES_PR:\s*#?(\d+)/i.exec(p.proposed_change || "");
  if (dep) {
    const r = await run("gh", ["pr", "view", dep[1], "--repo", REPO, "--json", "state", "-q", ".state"], ROOT, 60_000);
    const state = r.out.trim();
    if (!r.ok) return finish(p.id, "pending_approval", `Couldn't check PR #${dep[1]}; approve again to retry.`);
    if (state !== "MERGED") {
      return finish(p.id, "pending_approval", `Waiting: this builds on PR #${dep[1]}, which is ${state || "not merged"}. Merge it first, then approve this again. Nothing was built.`);
    }
  }
  const declared = await evaluateParents(parseDeclaredParents(p), undefined, p.id);
  if (declared.some((d) => !d.ok)) return finish(p.id, "pending_approval", waitingMessage(declared));
  const parentNote = mergedNote(declared);
  const branch = `engineer/fix-${p.id}`;
  const dir = path.join(WORK_ROOT, `fix-${p.id}`);
  let summary = "";

  // Only ever removes our own scratch clone.
  const cleanup = () => {
    if (dir.startsWith(WORK_ROOT + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
  };
  const fail = (why: string, detail?: string, kind?: FailKind) => {
    if (kind === "typecheck") {
      // A typecheck failure caused only by an unmerged earlier fix is an ordering problem, not a failed build.
      const ids = inferParentsFromErrors(detail ?? "", realDeps.candidates(p.id));
      if (ids.length) {
        evaluateParents(ids, undefined, p.id).then(
          (ps) => {
            const bad = ps.filter((x) => !x.ok);
            cleanup();
            if (bad.length) finish(p.id, "pending_approval", waitingMessage(bad), null, null);
            else realFail(why, detail, kind);
          },
          () => realFail(why, detail, kind)
        );
        return;
      }
    }
    realFail(why, detail, kind);
  };
  const realFail = (why: string, detail?: string, kind?: FailKind) => {
    cleanup();
    const c = classifyFailure(`${why}\n${detail ?? ""}\n${summary}`);
    const failKind = kind && c.kind !== "usage_limit" ? kind : c.kind;
    finish(
      p.id,
      "failed",
      `${summary}\n\n${why} Nothing on the live server was changed.${detail ? `\n\n${detail}` : ""}`.trim(),
      failKind,
      failKind === "usage_limit" ? c.retryAfter : null
    );
    logIssue("fix_proposal", `Fix #${p.id} (PR build) failed: ${why}`, detail);
  };

  try {
    fs.mkdirSync(WORK_ROOT, { recursive: true });
    cleanup();

    const fetched = await run("git", [`--git-dir=${GIT_DIR}`, "fetch", "-q", "origin", "+main:refs/heads/main"], ROOT, 120_000);
    if (!fetched.ok) return fail("Couldn't fetch the latest code from GitHub (is the gh login still valid?).", fetched.out.slice(-600));
    const cloned = await run("git", ["clone", "-q", GIT_DIR, dir], ROOT, 120_000);
    if (!cloned.ok) return fail("Couldn't make a working copy.", cloned.out.slice(-600));
    await run("git", ["remote", "set-url", "origin", `https://github.com/${REPO}.git`], dir);
    await run("git", ["checkout", "-q", "-b", branch], dir);

    let listed: string[] = [];
    try {
      const parsedFiles = JSON.parse(p.files || "[]");
      if (Array.isArray(parsedFiles)) listed = parsedFiles.filter((x) => typeof x === "string");
    } catch {}
    const implicitIds = inferParentsFromFiles(listed, (f) => fs.existsSync(path.join(dir, f)), realDeps.candidates(p.id));
    if (implicitIds.length) {
      const implicit: Parent[] = (await evaluateParents(implicitIds, undefined, p.id)).filter((x) => !x.ok);
      if (implicit.length) {
        cleanup();
        return finish(p.id, "pending_approval", waitingMessage(implicit));
      }
    }

    // Share the live release's installed packages (hard links, read-only use) when the lockfile matches.
    const live = fs.realpathSync(path.join(ROOT, "current"));
    const sameLock = fs.readFileSync(path.join(live, "package-lock.json"), "utf8") === fs.readFileSync(path.join(dir, "package-lock.json"), "utf8");
    if (!sameLock) return fail("Dependencies changed on main since the live release; deploy that first, then retry.");
    const linked = await run("cp", ["-al", path.join(live, "node_modules"), path.join(dir, "node_modules")], ROOT, 300_000);
    if (!linked.ok) return fail("Couldn't set up packages for the working copy.", linked.out.slice(-400));

    const baselineErrors = tscErrors((await typecheck(dir)).out); // already broken on main: not this change's fault
    const approver = approvedBy === "owner" ? "Owner" : "the Chief of Staff";
    const isCleanup = p.proposed_by === "cleanup";
    if (isCleanup) {
      let list: string[] = [];
      try {
        const parsed = JSON.parse(p.files || "[]");
        if (Array.isArray(parsed)) list = parsed.filter((x) => typeof x === "string");
      } catch {}
      const res = await removeCleanupFiles(dir, list, run);
      const refusedText = res.refused.map((r) => `${r.file}: ${r.reason}`).join("; ");
      if (!res.removed.length) return fail("Cleanup removed nothing.", refusedText || "No files were listed.", "policy");
      summary = `Removed ${res.removed.length} file(s) with git rm: ${res.removed.join(", ")}.${refusedText ? ` Refused: ${refusedText}.` : ""}`;
    }
    const prompt =`${CORE_AGENTS.full_stack_engineer.hard}

You are now in BUILD MODE: ${approver} approved this change. You are working in a throwaway copy of the repo on a branch; Owner reviews and merges the pull request that results. Apply exactly this change, nothing broader. Follow CLAUDE.md. Do not delete or empty any file. You can't run npm or any shell, so don't add packages. If the fix is for a UI bug, also add a Playwright test in e2e/ that would have caught it (tests must never press Send or trigger an agent). Only edit files inside the current folder.

Title: ${p.title}
Diagnosis: ${p.diagnosis}${parentNote ? `\n${parentNote}` : ""}
Change: ${p.proposed_change}
Files: ${p.files}
${p.cos_review ? `Review notes: ${p.cos_review}` : ""}

Reply with a 1-3 sentence summary of what you changed.`;

    const abortController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, BUILD_TIMEOUT_MS);
    try {
      if (!isCleanup) {
      const result = query({
        prompt,
        options: {
          abortController,
          model: MODEL,
          cwd: dir,
          ...LOCKED_BASE,
          tools: ["Read", "Grep", "Glob", "Edit", "Write"],
          allowedTools: ["Read", "Grep", "Glob", "Edit", "Write"],
          disallowedTools: ["Bash", "Task", "Agent", "WebSearch", "WebFetch", ...SECRET_READ_DENY, ...CODE_WRITE_DENY, ...SERVER_DENY],
          maxTurns: 40,
        },
      });
      for await (const m of result) {
        if (m.type === "result") summary = m.subtype === "success" ? m.result : `Stopped early: ${m.subtype}`;
      }
      }
    } catch (e) {
      if (!timedOut) throw e;
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) return fail(`The build step ran longer than ${BUILD_TIMEOUT_MS / 60_000} minutes and was stopped.`);

    const status = await run("git", ["status", "--porcelain", "--untracked-files=all"], dir);
    const { changed, deleted } = parsePorcelain(status.out);
    if (!changed.length) return fail("The engineer made no changes.");
    const violations = isCleanup ? [] : deleted.map((f) => `${f} was deleted`);
    for (const f of changed) {
      if (deleted.includes(f)) continue;
      const abs = path.join(dir, f);
      if (!fs.existsSync(abs)) continue;
      const now = fs.readFileSync(abs, "utf8");
      if (now.trim() === "") violations.push(`${f} was emptied`);
      const was = await run("git", ["show", `HEAD:${f}`], dir);
      const wasLines = was.ok ? was.out.split("\n").length : 0;
      if (wasLines > 40 && now.split("\n").length < wasLines * 0.2) violations.push(`${f} was mostly removed`);
    }
    if (violations.length) return fail(`The change deleted or gutted files (${violations.join("; ")}), which needs Owner's express permission.`, undefined, "policy");
    const touched = changed.filter((f) => /^package(-lock)?\.json$/.test(f) || f.startsWith(".github/"));
    if (touched.length) return fail(`It changed ${touched.join(", ")}, which has to go through a normal PR from the Mac.`, undefined, "policy");

    const tc = await typecheck(dir);
    if (tc.missing.length) return fail(`It needs new packages (${tc.missing.join(", ")}); add those in a normal PR from the Mac.`, undefined, "policy");
    const newErrors = [...tscErrors(tc.out)].filter((e) => !baselineErrors.has(e));
    if (!tc.ok && (newErrors.length || !baselineErrors.size))
      return fail("The code didn't type-check after the change.", (newErrors.join("\n") || tc.out).slice(0, 3000), "typecheck");
    const tscNote = tc.ok ? "Type-check passes" : `Type-check has only the ${baselineErrors.size} error(s) that were already on main`;

    let listedFiles: string[] = [];
    try {
      const lf = JSON.parse(p.files || "[]");
      if (Array.isArray(lf)) listedFiles = lf.map(String);
    } catch {}
    const strays = findStrays(changed, listedFiles);
    const keptStrays = findListedStrays(changed, listedFiles);
    const strayNotes: string[] = [];
    if (strays.length) strayNotes.push(`[stray files left out: ${strays.join(", ")}]`);
    if (keptStrays.length) strayNotes.push(`[scratch-looking files kept because the proposal listed them: ${keptStrays.join(", ")}]`);
    if (strays.length) {
      const keep = changed.filter((f) => !strays.includes(f));
      await run("git", ["add", "-A", "--", ...keep], dir);
    } else {
      await run("git", ["add", "-A"], dir);
    }
    if (strayNotes.length) summary = `${summary}\n\n${strayNotes.join("\n")}`.trim();
    const committed = await run("git", ["commit", "-q", "-m", `${p.title}\n\n${p.diagnosis}\n\nBuilt by the OS engineer on the server (fix #${p.id}); approved by ${approver}.`], dir);
    if (!committed.ok) return fail("Couldn't commit the change.", committed.out.slice(-600));
    const pushed = await run("git", ["push", "-q", "-u", "origin", branch], dir, 180_000);
    if (!pushed.ok) return fail("Couldn't push the branch to GitHub.", pushed.out.slice(-600));

    const body = `${p.diagnosis}\n\n## Change\n${p.proposed_change}\n\n## Files changed\n${changed.filter((f) => !strays.includes(f)).map((f) => `- ${f}`).join("\n")}\n\n${strayNotes.length ? `${strayNotes.join("\n")}\n\n` : ""}${
      p.cos_review ? `## Review notes\n${p.cos_review}\n\n` : ""
    }## Checks\n${tscNote}. **UI tests were not run** (the server has no test browser): run \`npm run test:e2e:branch\` on the Mac before merging.\n\nBuilt by the OS engineer on the server (fix #${p.id}), approved by ${approver}. Merge, then use **Deploy to server**.`;
    const pr = await run("gh", ["pr", "create", "--repo", REPO, "--head", branch, "--base", "main", "--title", p.title, "--body", body], dir, 120_000);
    if (!pr.ok) return fail("The branch was pushed but the PR couldn't be opened.", pr.out.slice(-600));
    const url = pr.out.trim().split("\n").pop() || "";

    cleanup();
    finish(
      p.id,
      "sent_to_github",
      `${summary}\n\nOpened ${url}. ${tscNote}; UI tests weren't run on the server. It still needs Owner's merge, then Deploy to server. Approved by ${approver}.`.trim()
    );
  } catch (e: any) {
    fail(`Building the pull request crashed: ${e.message}.`);
  }
}
