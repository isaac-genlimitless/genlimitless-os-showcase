// Unit tests for updatePRBranch with a fake `gh` on PATH. No network, never sends or triggers an agent.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakegh-"));
const log = path.join(dir, "calls.log");
fs.writeFileSync(
  path.join(dir, "gh"),
  `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  pr) echo "$FAKE_PR_JSON" ;;
  api) exit 0 ;;
esac
`,
  { mode: 0o755 }
);
process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
process.env.GITHUB_REPO = "owner/repo";
// Mirror mode makes mergePR stop after the GitHub merge (no git pull / e2e in tests).
process.env.IMESSAGE_MIRROR_DIR ||= path.join(dir, "mirror");

const pr = (state: string, head: string) =>
  JSON.stringify({ number: 80, title: "t", state, headRefName: head, baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", statusCheckRollup: [] });

const apiCalls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("api ")) : []);

test("rejects a non-engineer/* head", async () => {
  const { updatePRBranch } = await import("./github");
  process.env.FAKE_PR_JSON = pr("OPEN", "claude/issue-5-x");
  await assert.rejects(() => updatePRBranch(80), /not an engineer/);
  assert.equal(apiCalls().length, 0);
});

test("rejects closed PRs", async () => {
  const { updatePRBranch } = await import("./github");
  process.env.FAKE_PR_JSON = pr("CLOSED", "engineer/fix-131");
  await assert.rejects(() => updatePRBranch(80), /not OPEN/);
  assert.equal(apiCalls().length, 0);
});

test("openMissingClaudePRs skips empty branches and still opens later ones", async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "fakegh2-"));
  const log2 = path.join(dir2, "calls.log");
  fs.writeFileSync(
    path.join(dir2, "gh"),
    `#!/bin/sh
echo "$@" >> "${log2}"
case "$1 $2" in
  "api repos/owner/repo/branches?per_page=100") echo '["claude/issue-19-a","claude/issue-20-b"]' ;;
  "pr list") echo '[]' ;;
  "issue view") echo '{"title":"T","comments":[]}' ;;
  "pr create")
    case "$*" in
      *claude/issue-19-a*) echo "pull request create failed: No commits between main and claude/issue-19-a" >&2; echo "No commits between main and claude/issue-19-a"; exit 1 ;;
      *) echo "https://github.com/owner/repo/pull/99" ;;
    esac ;;
esac
`,
    { mode: 0o755 }
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir2}${path.delimiter}${oldPath}`;
  try {
    const { openMissingClaudePRs } = await import("./github");
    await openMissingClaudePRs();
    const creates = () => fs.readFileSync(log2, "utf8").split("\n").filter((l) => l.startsWith("pr create"));
    assert.equal(creates().length, 2);
    assert.ok(creates().some((l) => l.includes("claude/issue-20-b")));
    await openMissingClaudePRs();
    assert.equal(creates().filter((l) => l.includes("claude/issue-19-a")).length, 1);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("mergePR: branch delete failure does not throw and state becomes MERGED; non-engineer branches never deleted", async () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "fakegh3-"));
  const log3 = path.join(dir3, "calls.log");
  fs.writeFileSync(
    path.join(dir3, "gh"),
    `#!/bin/sh
echo "$@" >> "${log3}"
case "$1" in
  pr) case "$2" in view) echo "$FAKE_PR_JSON" ;; esac ;;
  api) echo "HTTP 500 boom" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 }
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir3}${path.delimiter}${oldPath}`;
  try {
    const { mergePR } = await import("./github");
    const db = (await import("./db")).default;
    db.prepare(`INSERT OR REPLACE INTO github_prs (number, title, url, state) VALUES (80, 't', 'u', 'OPEN')`).run();
    process.env.FAKE_PR_JSON = pr("OPEN", "engineer/fix-131");
    const res = await mergePR(80);
    assert.equal(res.ok, true);
    assert.equal((db.prepare(`SELECT state FROM github_prs WHERE number=80`).get() as any).state, "MERGED");
    const calls = () => fs.readFileSync(log3, "utf8").split("\n");
    assert.ok(calls().some((l) => l.startsWith("api -X DELETE repos/owner/repo/git/refs/heads/engineer/fix-131")));
    assert.ok(!calls().some((l) => l.includes("--delete-branch")));

    const before = calls().filter((l) => l.startsWith("api ")).length;
    process.env.FAKE_PR_JSON = pr("OPEN", "claude/issue-5-x");
    await mergePR(80);
    assert.equal(calls().filter((l) => l.startsWith("api ")).length, before);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("calls update-branch for engineer/fix-131", async () => {
  const { updatePRBranch } = await import("./github");
  process.env.FAKE_PR_JSON = pr("OPEN", "engineer/fix-131");
  const res = await updatePRBranch(80);
  assert.equal(res.ok, true);
  const calls = apiCalls();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /-X PUT repos\/owner\/repo\/pulls\/80\/update-branch/);
});
