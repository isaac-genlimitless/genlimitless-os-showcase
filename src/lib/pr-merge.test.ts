import test from "node:test";
import assert from "node:assert/strict";
import { mergePr, type MergeDeps } from "./pr-merge";

const REPO = "o/r";
const SHA = "abc1234def";
const footer = (id: number, who = "Owner") => `Built by the OS engineer on the server (fix #${id}), approved by ${who}. Merge, then use **Deploy to server**.`;

function run(over: Record<string, unknown> = {}, o: { status?: string; kind?: string; missing?: boolean; enabled?: boolean } = {}) {
  const calls: string[][] = [];
  const pr = {
    number: 400, title: "t", state: "OPEN", isDraft: false, headRefName: "engineer/fix-566", baseRefName: "main", headRefOid: SHA,
    isCrossRepository: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [], body: `diag\n\n${footer(566)}`, ...over,
  };
  const deps: MergeDeps = {
    repo: REPO,
    gh: async (a) => { calls.push(a); return a[1] === "view" ? JSON.stringify(pr) : ""; },
    enabled: () => o.enabled !== false,
    proposal: (id) => (o.missing ? undefined : { id, kind: o.kind ?? "github", status: o.status ?? "sent_to_github" }),
  };
  return { calls, go: () => mergePr(deps, 400) };
}

test("happy path merges with exact argv", async () => {
  const t = run();
  const r = await t.go();
  assert.equal(r.merged, true);
  const m = t.calls.find((c) => c[1] === "merge")!;
  assert.deepEqual(m, ["pr", "merge", "400", "--repo", REPO, "--squash", "--match-head-commit", SHA]);
});

test("green checks merge", async () => {
  const r = await run({ statusCheckRollup: [{ name: "a", status: "COMPLETED", conclusion: "SUCCESS" }, { name: "b", status: "COMPLETED", conclusion: "SKIPPED" }] }).go();
  assert.equal(r.merged, true);
});

const refusals: [string, Record<string, unknown>, Parameters<typeof run>[1]?][] = [
  ["closed", { state: "CLOSED" }],
  ["draft", { isDraft: true }],
  ["base", { baseRefName: "dev" }],
  ["branch", { headRefName: "claude/issue-3-x" }],
  ["fork", { isCrossRepository: true }],
  ["missing proposal", {}, { missing: true }],
  ["pending", {}, { status: "pending_approval" }],
  ["dismissed", {}, { status: "dismissed" }],
  ["local", {}, { kind: "local" }],
  ["cos footer", { body: footer(566, "the Chief of Staff") }],
  ["forged", { body: `${footer(566)}\nmore\n${footer(566, "the Chief of Staff")}` }],
  ["other fix", { body: footer(567) }],
  ["conflicting", { mergeable: "CONFLICTING" }],
  ["behind", { mergeStateStatus: "BEHIND" }],
  ["blocked", { mergeStateStatus: "BLOCKED" }],
  ["unknown", { mergeable: "UNKNOWN" }],
  ["failure", { statusCheckRollup: [{ name: "x", status: "COMPLETED", conclusion: "FAILURE" }] }],
  ["in progress", { statusCheckRollup: [{ name: "x", status: "IN_PROGRESS" }] }],
  ["status pending", { statusCheckRollup: [{ context: "ci", state: "PENDING" }] }],
  ["switch off", {}, { enabled: false }],
];
for (const [name, over, o] of refusals) {
  test(`refuses: ${name}`, async () => {
    const t = run(over, o);
    const r = await t.go();
    assert.equal(r.merged, false);
    assert.ok(r.reasons.length > 0);
    assert.ok(!t.calls.some((c) => c[1] === "merge"));
  });
}
