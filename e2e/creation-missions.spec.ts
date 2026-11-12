// The Creation's autonomous agents ("missions"): the runner with a FAKE model stream, the agents' tools, the
// API and the UI. Runs against the isolated test database/server only. No real model is ever called and no
// agent is ever triggered: API/UI tests only queue for "tonight" and cancel.
// One serial file on purpose: the cap test fills the shared rolling-24h ledger, so nothing may run beside it.
import { test, expect } from "./isolated-test";
import db from "../src/lib/db";
import { createCreation, createSandbox, decidePromotion, ensureCreationsSchema, getCreation } from "../src/lib/creations/store";
import { createMission, getMission, missionToolHandlers, runMission, spentLast24h, tonightUtc, type QueryFn } from "../src/lib/creations/missions";

test.describe.configure({ mode: "serial" });

/** A fake SDK stream: one assistant message per entry, each reporting `tokens` of input. Honors abort like the SDK. */
function fakeQuery(perCall: number[]): QueryFn {
  return ((args: { options: { abortController: AbortController } }) => (async function* () {
    let i = 0;
    for (const tokens of perCall) {
      if (args.options.abortController.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      yield { type: "assistant", parent_tool_use_id: null, message: { id: `m${i++}`, content: [{ type: "text", text: `step ${i}` }], usage: { input_tokens: tokens, output_tokens: 0 } } };
    }
    yield { type: "result", subtype: "success", result: "done", num_turns: perCall.length };
  })()) as unknown as QueryFn;
}

let slug = "";
test.beforeAll(async () => {
  await ensureCreationsSchema();
  slug = createCreation({ title: "E2E Missions Lab" }).slug;
});

test("a run that would cross its budget is stopped before the next call; every token is in the ledger", async () => {
  const before = spentLast24h();
  const m = createMission(slug, { role: "modeler", goal: "E2E stress the site model under a bad case", budget: 50_000 });
  expect(m.status).toBe("queued");
  const canonBefore = getCreation(slug).canon.version.number;
  // 30k, then the next call is projected at 45k → 75k > 50k, so it stops after the first call.
  const done = await runMission(m.id, { query: fakeQuery([30_000, 30_000, 30_000]) });
  expect(done.status).toBe("stopped");
  expect(done.used_tokens).toBe(30_000);
  expect(done.stop_reason).toMatch(/stay within its 50,000-token budget/);
  expect(spentLast24h() - before).toBe(30_000);
  expect(done.sandbox_id).toBeTruthy();
  expect(getCreation(slug).canon.version.number).toBe(canonBefore); // canon untouched
  const run = db.prepare(`SELECT status, agent_slug FROM agent_runs WHERE id = ?`).get(done.run_id) as { status: string; agent_slug: string };
  expect(run.agent_slug).toBe("creation_modeler");
  expect(getCreation(slug).feed.some((f) => f.kind === "mission" && /stopped/.test(f.title))).toBe(true);
});

test("a small run finishes and records its spend", async () => {
  const m = createMission(slug, { role: "inventor", goal: "E2E list three new directions", budget: 100_000 });
  const done = await runMission(m.id, { query: fakeQuery([5_000, 6_000]) });
  expect(done.status).toBe("done");
  expect(done.used_tokens).toBe(11_000);
});

test("agent tools: only its own sandbox; proposals wait for Owner; agents can't approve", async () => {
  const own = createSandbox(slug, { title: "E2E agent sb" }, "agent:skeptic", "agent");
  const owners = createSandbox(slug, { title: "E2E owner sb" });
  const h = missionToolHandlers({ slug, creationId: own.creation_id, sandboxId: own.id, actor: "agent:skeptic", missionId: 0, finished: { report: null } });
  expect(h.read_canon()).toContain("Canon v");
  expect(h.write_doc({ title: "E2E weak spots", body: "facilitator turnover" })).toContain("Saved doc");
  expect(h.run_site_model({ inputs: { microschool_students: 60 } })).toMatch(/Net\/yr/);
  const other = missionToolHandlers({ slug, creationId: own.creation_id, sandboxId: owners.id, actor: "agent:skeptic", missionId: 0, finished: { report: null } });
  expect(() => other.write_doc({ title: "x", body: "y" })).toThrow(/only change its own sandbox/);
  const proposed = h.propose_to_canon({ rationale: "E2E" });
  expect(proposed).toContain("Owner will approve");
  const pending = getCreation(slug).promotions.find((p) => p.status === "pending" && p.proposed_by === "agent:skeptic")!;
  expect(() => decidePromotion(pending.id, "approve", "agent:skeptic")).toThrow(/only the owner/);
  const fin = { report: null as string | null };
  missionToolHandlers({ slug, creationId: own.creation_id, sandboxId: own.id, actor: "agent:skeptic", missionId: 0, finished: fin }).finish({ report: "E2E report" });
  expect(fin.report).toBe("E2E report");
});

test("tonight means the next 1:00 AM Central, in the future", () => {
  const now = new Date("2026-11-04T23:10:00Z"); // 5:10 PM Central
  expect(tonightUtc(now)).toBe("2026-11-05 07:00:00"); // 1:00 AM CST = 07:00 UTC
});

test("queue a mission for tonight, see the cap, cancel it; bad input is refused", async ({ request }) => {
  const c = await (await request.post("/api/creations", { data: { title: "E2E Missions API" } })).json();
  const slug = c.creation.slug;
  const url = `/api/creations/${slug}/missions`;
  expect((await request.post(url, { data: { role: "wizard", goal: "E2E do something useful", when: "tonight" } })).status()).toBe(400);
  expect((await request.post(url, { data: { role: "inventor", goal: "short", when: "tonight" } })).status()).toBe(400);
  const r = await request.post(url, { data: { role: "inventor", goal: "E2E generate ten site concepts", budget: 9_999_999, when: "tonight" } });
  expect(r.status()).toBe(201);
  const m = (await r.json()).mission;
  expect(m.status).toBe("queued");
  expect(m.scheduled_for).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  expect(m.budget_tokens).toBeLessThanOrEqual(400_000);
  const list = await (await request.get(url)).json();
  expect(list.budget.cap).toBe(1_000_000);
  expect(list.roles.map((x: { key: string }) => x.key)).toEqual(["inventor", "researcher", "modeler", "architect", "skeptic", "producer"]);
  const stopped = await (await request.post(`/api/creations/missions/${m.id}`, { data: { action: "stop" } })).json();
  expect(stopped.mission.status).toBe("cancelled");
});

test("the Agents panel queues tonight's mission from the workspace", async ({ page, request }) => {
  const c = await (await request.post("/api/creations", { data: { title: "E2E Missions UI" } })).json();
  await page.goto(`/the-creation/${c.creation.slug}`);
  await page.getByTestId("missions-toggle").click();
  await expect(page.getByTestId("token-budget")).toContainText("1000K");
  await page.getByTestId("mission-role").selectOption("skeptic");
  await page.getByTestId("mission-when").selectOption("tonight");
  await page.getByTestId("mission-goal").fill("E2E attack the land-value capture plan as a county planner");
  await page.getByTestId("mission-start").click();
  await expect(page.getByTestId("mission-msg")).toContainText("1:00 AM");
  const item = page.getByTestId("mission-list").locator("li").first();
  await expect(item).toContainText("skeptic");
  await item.getByTestId("mission-stop").click();
  await expect(item).toContainText("cancelled");
});

test("when the daily cap is used up, nothing new starts and queued work is stopped, not run", async () => {
  const queued = createMission(slug, { role: "researcher", goal: "E2E find zoning rules for the region", budget: 50_000 });
  const fill = Number(db.prepare(`INSERT INTO creation_token_ledger (mission_id, tokens) VALUES (0, ?)`).run(1_000_000 - spentLast24h() - 5_000).lastInsertRowid);
  try {
  expect(() => createMission(slug, { role: "inventor", goal: "E2E this should be refused" })).toThrow(/daily cap is left/);
  let called = false;
  const spy = ((...a: unknown[]) => { called = true; return (fakeQuery([1]) as unknown as (...x: unknown[]) => unknown)(...a); }) as unknown as QueryFn;
  const r = await runMission(queued.id, { query: spy });
  expect(called).toBe(false);
  expect(r.status).toBe("stopped");
  expect(getMission(queued.id).stop_reason).toMatch(/daily cap/);
  } finally {
    // Age the fake spend out of the 24h window (isolated test DB only) so nothing after this is affected.
    db.prepare(`UPDATE creation_token_ledger SET at = datetime('now', '-2 days') WHERE id = ?`).run(fill);
  }
  expect(spentLast24h()).toBeLessThan(100_000);
});
