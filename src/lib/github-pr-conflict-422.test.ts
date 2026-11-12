// A 422 merge conflict from update-branch is an expected outcome: no issue row, and one attempt per PR per main commit.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakegh422-"));
const log = path.join(dir, "calls.log");
fs.writeFileSync(
  path.join(dir, "gh"),
  `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  pr) echo "$FAKE_PR_JSON" ;;
  api) echo "HTTP 422: merge conflict between base and head" >&2; exit 1 ;;
esac
`,
  { mode: 0o755 }
);
process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
process.env.GITHUB_REPO = "owner/repo";

const prJson = JSON.stringify({ number: 80, title: "t", state: "OPEN", headRefName: "engineer/fix-131", baseRefName: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", statusCheckRollup: [] });
const putCalls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("api -X PUT")) : []);

test("updatePRBranch on 422 returns ok:false and logs no issue", async () => {
  const { updatePRBranch } = await import("./github");
  const db = (await import("./db")).default;
  process.env.FAKE_PR_JSON = prJson;
  const count = () => (db.prepare(`SELECT COUNT(*) AS c FROM issues`).get() as any).c;
  const before = count();
  const res = await updatePRBranch(80);
  assert.equal(res.ok, false);
  assert.equal(count(), before);
});

test("handlePr calls update-branch only once for the same conflicting PR", async () => {
  const { handlePr } = await import("./pr-conflict-watch");
  process.env.FAKE_PR_JSON = prJson;
  const { updatePRBranch } = await import("./github");
  const deps = {
    getStatus: async () => ({ state: "OPEN", mergeable: "CONFLICTING", has_conflicts: true, behind_base: false }),
    updateBranch: updatePRBranch,
    rebuild: async () => "skip",
  };
  const before = putCalls().length;
  await handlePr(80, "engineer/fix-131", "owner/repo", "sha1", deps);
  const second = await handlePr(80, "engineer/fix-131", "owner/repo", "sha1", deps);
  assert.equal(second, "already");
  assert.equal(putCalls().length - before, 1);
});
