import { test, expect } from "@playwright/test";
import { evaluatePr, type PrFile } from "../src/lib/auto-merge-policy";
import { autoMergeTick, reconcileDeploys, type Deps, type LogRow } from "../src/lib/auto-merge";

// Pure: no server, no database, no GitHub. Fakes stand in for gh and glos-deploy.

const B = "engineer/fix-7";
const mod = (filename: string, patch: string, additions = 3, deletions = 1): PrFile => ({ filename, status: "modified", additions, deletions, patch });
const ui = mod("src/app/tasks/page.tsx", "@@ -1,2 +1,3 @@\n-old\n+const label = 'Tasks';\n+<h1>{label}</h1>");

test("an ordinary UI change is allowed", () => {
  expect(evaluatePr(B, [ui])).toEqual({ allow: true, reasons: [] });
  expect(evaluatePr(B, [{ filename: "e2e/new.spec.ts", status: "added", additions: 20, deletions: 0, patch: "+test('x', () => {});" }]).allow).toBe(true);
});

test("only engineer/fix-N branches, and never an empty PR", () => {
  for (const b of ["main", "job-engine-bridge", "engineer/fix-", "engineer/fix-7/extra", "feature/engineer/fix-7"]) expect(evaluatePr(b, [ui]).allow, b).toBe(false);
  expect(evaluatePr(B, []).allow).toBe(false);
});

test("whole-file deletes, renames and gutted files are held", () => {
  expect(evaluatePr(B, [{ filename: "src/lib/x.ts", status: "removed", additions: 0, deletions: 40, patch: "-a" }]).reasons.join()).toMatch(/deletes the whole file/);
  expect(evaluatePr(B, [{ filename: "src/lib/y.ts", status: "renamed", additions: 0, deletions: 0 }]).allow).toBe(false);
  expect(evaluatePr(B, [mod("src/lib/z.ts", "+a", 2, 120)]).reasons.join()).toMatch(/guts the file/);
  expect(evaluatePr(B, [mod("src/lib/z.ts", "+a", 80, 40)]).allow).toBe(true); // a rewrite is not a gutting
});

test("anything that sends to someone external is held", () => {
  expect(evaluatePr(B, [mod("src/lib/mail.ts", "+const a = 1;")]).allow).toBe(false); // touching a send file at all
  expect(evaluatePr(B, [mod("src/lib/agents/tools.ts", "+const a = 1;")]).allow).toBe(false);
  expect(evaluatePr(B, [mod("src/app/api/email/route.ts", "+const a = 1;")]).allow).toBe(false);
  for (const added of [
    "+await transporter.sendMail({ to })",
    "+import nodemailer from 'nodemailer';",
    '+await fetch("https://hooks.example.com/x", { method: "POST" })',
    "+await fetch(url)",
    "+await fetch(`//evil.example/x`)",
    '+execFile("osascript", args)',
    "+const t = process.env.GMAIL_APP_PASSWORD;",
  ]) expect(evaluatePr(B, [mod("src/lib/helper.ts", added)]).allow, added).toBe(false);
  // the app's own API and plain comments are fine
  expect(evaluatePr(B, [mod("src/app/tasks/page.tsx", '+await fetch("/api/tasks", { method: "POST" })')]).allow).toBe(true);
  expect(evaluatePr(B, [mod("src/app/tasks/page.tsx", "+// we used to call sendMail( here")]).allow).toBe(true);
});

test("login/security, packages, database and deploy code are held", () => {
  for (const f of ["src/lib/auth/crypto.ts", "src/proxy.ts", "src/lib/agent-lock.ts", "src/lib/job-engine/signature.ts", "bridge/glos-deploy", "src/lib/auto-merge.ts", "src/lib/auto-merge-server.ts", "src/lib/auto-merge-policy.ts", "next.config.ts", ".github/workflows/claude.yml", ".env.local", "src/lib/pr-builder.ts"])
    expect(evaluatePr(B, [mod(f, "+x")]).allow, f).toBe(false);
  for (const f of ["package.json", "package-lock.json"]) expect(evaluatePr(B, [mod(f, "+x")]).reasons.join(), f).toMatch(/packages/);
  expect(evaluatePr(B, [mod("src/lib/db.ts", "+x")]).reasons.join()).toMatch(/database/);
  for (const sql of ["+db.exec('DROP TABLE tasks')", "+db.prepare(`DELETE FROM tasks`).run()", "+ALTER TABLE tasks ADD x TEXT", "+fs.rmSync(dir, { recursive: true })"])
    expect(evaluatePr(B, [mod("src/lib/tasks.ts", sql)]).allow, sql).toBe(false);
});

test("fails closed: unseen diff or too big", () => {
  expect(evaluatePr(B, [{ filename: "src/app/a.tsx", status: "modified", additions: 5, deletions: 1 }]).reasons.join()).toMatch(/can't be checked/);
  expect(evaluatePr(B, Array.from({ length: 26 }, (_, i) => mod(`src/app/f${i}.tsx`, "+x"))).allow).toBe(false);
  expect(evaluatePr(B, [mod("src/app/a.tsx", "+x", 1300, 0)]).allow).toBe(false);
});

// ---- orchestrator with fakes ----------------------------------------------------------------

type World = { calls: string[]; rows: LogRow[]; notes: string[]; problems: string[]; held: string[]; live: string; latest: string; deployState: string; mergeable: string; ours: boolean; killed: boolean; files: PrFile[]; deployFails: boolean };
function world(over: Partial<World> = {}): { w: World; deps: Deps } {
  const w: World = { calls: [], rows: [], notes: [], problems: [], held: [], live: "aaaaaaaaaaaa", latest: "bbbbbbbbbbbb", deployState: "idle", mergeable: "clean", ours: true, killed: false, files: [ui], deployFails: false, ...over };
  const deps: Deps = {
    repo: "o/r",
    killed: () => w.killed,
    fixIsOurs: () => w.ours,
    gh: async (a) => {
      w.calls.push(a.join(" "));
      if (a[0] === "pr" && a[1] === "list") return JSON.stringify([{ number: 5, headRefName: B }, { number: 6, headRefName: "job-engine-bridge" }]);
      if (a[0] === "api" && /pulls\/5$/.test(a[1])) return JSON.stringify({ state: "open", draft: false, mergeable_state: w.mergeable, head: { sha: "abc123", repo: { full_name: "o/r" } }, base: { repo: { full_name: "o/r" } } });
      if (a[0] === "api" && /pulls\/5\/files/.test(a[1])) return w.files.map((f) => JSON.stringify(f)).join("\n");
      if (a[0] === "pr" && a[1] === "merge") return "";
      throw new Error("unexpected gh call: " + a.join(" "));
    },
    log: {
      get: (pr, sha) => w.rows.find((r) => r.pr === pr && r.head_sha === sha),
      put: (pr, sha, status, reasons) => void w.rows.push({ pr, head_sha: sha, status, reasons: reasons ? JSON.stringify(reasons) : null, deploy_tries: 0 }),
      awaitingDeploy: () => w.rows.filter((r) => r.status === "merged"),
      setStatus: (rows, status, addTry) => rows.forEach((r) => { r.status = status; if (addTry) r.deploy_tries++; }),
    },
    deploy: {
      status: () => ({ state: w.deployState as any, message: "m", sha: "s", at: "t" }),
      live: () => w.live,
      latest: async () => w.latest,
      start: async () => { w.calls.push("DEPLOY"); if (w.deployFails) throw new Error("sudo refused"); },
    },
    held: (pr, _b, reasons) => void w.held.push(`#${pr}: ${reasons[0]}`),
    note: (m) => void w.notes.push(m),
    problem: (m) => void w.problems.push(m),
  };
  return { w, deps };
}

test("a clean engineer PR is merged pinned to the checked commit, then deployed; other branches are ignored", async () => {
  const { w, deps } = world();
  expect(await autoMergeTick(deps)).toEqual({ merged: 1, held: 0 });
  expect(w.calls).toContain("pr merge 5 --repo o/r --merge --match-head-commit abc123");
  expect(w.calls).toContain("DEPLOY");
  expect(w.calls.filter((c) => c.includes("pulls/6"))).toHaveLength(0);
  expect(w.rows[0]).toMatchObject({ pr: 5, head_sha: "abc123", status: "merged", deploy_tries: 1 });
});

test("a held PR is never merged or deployed, and is reported once per commit", async () => {
  const { w, deps } = world({ files: [mod("src/lib/mail.ts", "+x")] });
  expect(await autoMergeTick(deps)).toEqual({ merged: 0, held: 1 });
  expect(w.calls.some((c) => c.startsWith("pr merge"))).toBe(false);
  expect(w.calls).not.toContain("DEPLOY");
  expect(w.held).toHaveLength(1);
  await autoMergeTick(deps); // same commit again: already decided
  expect(w.held).toHaveLength(1);
});

test("a PR with no matching OS proposal is held even if the diff is harmless", async () => {
  const { w, deps } = world({ ours: false });
  expect(await autoMergeTick(deps)).toEqual({ merged: 0, held: 1 });
  expect(w.held[0]).toMatch(/no matching approved fix proposal/);
});

test("PRs that are not mergeable yet are skipped without a decision", async () => {
  for (const mergeable of ["behind", "dirty", "unstable", "blocked", "unknown"]) {
    const { w, deps } = world({ mergeable });
    expect(await autoMergeTick(deps)).toEqual({ merged: 0, held: 0 });
    expect(w.rows, mergeable).toHaveLength(0);
  }
});

test("the off switch stops everything", async () => {
  const { w, deps } = world({ killed: true });
  await autoMergeTick(deps);
  expect(w.calls).toHaveLength(0);
});

test("deploy: marks deployed once live matches main, waits while building, gives up after 3 tries", async () => {
  let { w, deps } = world({ live: "bbbbbbbbbbbb" });
  w.rows.push({ pr: 5, head_sha: "x", status: "merged", reasons: null, deploy_tries: 1 });
  await reconcileDeploys(deps);
  expect(w.rows[0].status).toBe("deployed");
  expect(w.notes[0]).toMatch(/Auto-deployed #5/);

  ({ w, deps } = world({ deployState: "running" }));
  w.rows.push({ pr: 5, head_sha: "x", status: "merged", reasons: null, deploy_tries: 1 });
  await reconcileDeploys(deps);
  expect(w.calls).not.toContain("DEPLOY");

  ({ w, deps } = world());
  w.rows.push({ pr: 5, head_sha: "x", status: "merged", reasons: null, deploy_tries: 3 });
  await reconcileDeploys(deps);
  expect(w.rows[0].status).toBe("deploy_failed");
  expect(w.problems[0]).toMatch(/didn't complete/);
  expect(w.calls).not.toContain("DEPLOY");

  ({ w, deps } = world({ deployFails: true }));
  w.rows.push({ pr: 5, head_sha: "x", status: "merged", reasons: null, deploy_tries: 0 });
  await reconcileDeploys(deps);
  expect(w.problems[0]).toMatch(/couldn't start/);
});
