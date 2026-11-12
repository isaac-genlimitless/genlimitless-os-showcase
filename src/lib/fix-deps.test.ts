// Unit tests: fixes wait for their parent fixes. Fake db/gh injected; no network, sends or agents.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDeclaredParents,
  resolveParent,
  parentState,
  inferParentsFromFiles,
  inferParentsFromErrors,
  waitingMessage,
  releaseWaitingFixes,
  mentionsReplacement,
  type Deps,
  type DepRow,
} from "./fix-deps";

function fake(rows: DepRow[], prs: Record<number, string> = {}): Deps {
  const kids = (id: number) => rows.filter((r) => (r as any).supersedes === id || (r as any).retry_of === id).sort((a, b) => b.id - a.id);
  return {
    getRow: (id) => rows.find((r) => r.id === id),
    children: kids,
    candidates: (before) => rows.filter((r) => r.id < before && ["applying", "cos_approved", "sent_to_github", "pending_approval"].includes(r.status)),
    waiting: () => rows.filter((r) => r.status === "pending_approval" && (r.result || "").startsWith("Waiting:") && (r.result || "").includes("[auto-release]")),
    prState: async (n) => prs[n] ?? "OPEN",
  };
}

function fakeR(rows: DepRow[], prs: Record<number, string> = {}): Deps {
  return { ...fake(rows, prs), replacers: (id) => rows.filter((r) => mentionsReplacement(r, id)).sort((a, b) => b.id - a.id) };
}
const r513: DepRow = { id: 513, status: "applied", cos_review: "[Chief of Staff: approve] replaces PR #350 (#502) and #503" };

test("mentionsReplacement matches replacement wording only for later rows", () => {
  assert.equal(mentionsReplacement(r513, 503), true);
  assert.equal(mentionsReplacement(r513, 504), false);
  assert.equal(mentionsReplacement(r513, 600), false);
});

test("resolveParent follows a text-declared replacement", () => {
  assert.equal(resolveParent(503, fakeR([{ id: 503, status: "failed" }, r513])), 513);
});

test("resolveParent unchanged when replacers is absent", () => {
  assert.equal(resolveParent(503, fake([{ id: 503, status: "failed" }, r513])), 503);
});

test("release follows replacement to an applied parent; waits if not merged", async () => {
  const waiter: DepRow = { id: 506, status: "pending_approval", result: "Waiting: this builds on #503 (failed). [auto-release]", size: "minor", cos_review: "[Chief of Staff: approve] ok", proposed_change: "REQUIRES_FIX: #503" };
  const started: number[] = [];
  const ok = await releaseWaitingFixes(fakeR([{ id: 503, status: "failed" }, r513, waiter]), (id) => void started.push(id));
  assert.deepEqual(ok, [506]);
  const pending = await releaseWaitingFixes(fakeR([{ id: 503, status: "failed" }, { ...r513, status: "cos_approved" }, waiter]), (id) => void started.push(id));
  assert.deepEqual(pending, []);
});

test("parses declared parents, ignoring self and higher ids", () => {
  assert.deepEqual(parseDeclaredParents({ id: 480, cos_review: "Apply after #472" }), [472]);
  assert.deepEqual(parseDeclaredParents({ id: 480, proposed_change: "REQUIRES_FIX: #1, #2" }), [1, 2]);
  assert.deepEqual(parseDeclaredParents({ id: 480, diagnosis: "apply AFTER #480, #481, #479" }), [479]);
});

test("follows a revised parent forward", () => {
  const d = fake([
    { id: 473, status: "failed" },
    { id: 475, status: "sent_to_github", supersedes: 473 } as any,
  ]);
  assert.equal(resolveParent(473, d), 475);
});

test("sent_to_github parent is ok only once the PR is merged", async () => {
  const rows = [{ id: 5, status: "sent_to_github", result: "Opened https://github.com/o/r/pull/12." }];
  const open = await parentState(5, fake(rows, { 12: "OPEN" }));
  assert.equal(open.ok, false);
  assert.match(open.reason, /PR #12 is OPEN/);
  assert.equal((await parentState(5, fake(rows, { 12: "MERGED" }))).ok, true);
  assert.equal((await parentState(5, fake([{ id: 5, status: "applied" }]))).ok, true);
  assert.equal((await parentState(5, fake([{ id: 5, status: "cos_approved" }]))).ok, false);
});

test("infers implicit parents from missing files and tsc errors", () => {
  const cands: DepRow[] = [{ id: 496, status: "sent_to_github", files: JSON.stringify(["src/lib/pwa-heal.ts"]) }];
  assert.deepEqual(inferParentsFromFiles(["src/lib/pwa-heal.ts", "a.ts"], (f) => f === "a.ts", cands), [496]);
  assert.deepEqual(inferParentsFromFiles(["src/lib/pwa-heal.ts"], () => true, cands), []);
  assert.deepEqual(inferParentsFromErrors("src/x.ts(1,1): error TS2307: Cannot find module '@/lib/pwa-heal' or its types.", cands), [496]);
});

test("waiting message names parents and files", () => {
  const m = waitingMessage([{ id: 496, ok: false, reason: "PR #9 is OPEN", files: ["src/lib/pwa-heal.ts"] }]);
  assert.match(m, /^Waiting: this builds on #496 \(PR #9 still OPEN\)/);
  assert.match(m, /src\/lib\/pwa-heal\.ts/);
  assert.ok(m.endsWith("[auto-release]"));
});

test("release starts a CoS-approved minor row only when the parent is merged; major stays waiting", async () => {
  const waitingResult = "Waiting: this builds on #5 (PR #12 still OPEN). [auto-release]";
  const rows: DepRow[] = [
    { id: 5, status: "sent_to_github", result: "https://github.com/o/r/pull/12" },
    { id: 6, status: "pending_approval", result: waitingResult, size: "minor", cos_review: "[Chief of Staff: approve] ok" },
  ];
  const started: number[] = [];
  assert.deepEqual(await releaseWaitingFixes(fake(rows, { 12: "OPEN" }), (id) => void started.push(id)), []);
  assert.deepEqual(await releaseWaitingFixes(fake(rows, { 12: "MERGED" }), (id) => void started.push(id)), [6]);
  assert.deepEqual(started, [6]);
});

// A rebuild of #502 (#513, retry_of 502) must not wait on itself, nor on the open PR it replaces.
const loop: DepRow[] = [
  { id: 502, status: "sent_to_github", result: "https://github.com/o/r/pull/350" },
  { id: 513, status: "pending_approval", retry_of: 502, size: "minor", cos_review: "[Chief of Staff: approve] replaces PR #350 (#502)", proposed_change: "Apply after #502", result: "Waiting: this builds on #513 (applying). [auto-release]" },
];

test("resolveParent with selfId never follows a row forward to itself", () => {
  assert.equal(resolveParent(502, fake(loop)), 513); // old behaviour without a ceiling
  assert.equal(resolveParent(502, fake(loop), 513), 502);
});

test("evaluateParents drops the row itself and a parent it replaces", async () => {
  const { evaluateParents } = await import("./fix-deps");
  const deps = fakeR(loop, { 350: "OPEN" });
  assert.deepEqual(await evaluateParents([502], deps, 513), []);
  // Without a selfId it is still reported as an unmerged parent (other callers unchanged).
  const without = await evaluateParents([502], deps);
  assert.equal(without.every((p) => p.id !== 513 || p.ok === false), true);
  // A genuine parent that is not replaced still blocks.
  const parents = await evaluateParents([500], fakeR([...loop, { id: 500, status: "sent_to_github", result: "https://github.com/o/r/pull/340" }], { 340: "OPEN" }), 513);
  assert.equal(parents.length, 1);
  assert.equal(parents[0].ok, false);
});

test("release starts a waiting row whose only parent was itself", async () => {
  const started: number[] = [];
  const out = await releaseWaitingFixes(fakeR(loop, { 350: "OPEN" }), (id) => void started.push(id));
  assert.deepEqual(out, [513]);
  assert.deepEqual(started, [513]);
});
