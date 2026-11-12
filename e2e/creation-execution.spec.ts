// The Creation, stage 6: execution steps. Writes data, so isolated only. Never presses Send, never triggers an
// agent: an approved email becomes a DRAFT (here it fails safely because the test server has no mail account),
// and an approved meeting becomes a pending calendar request in the approval queue, nothing more.
import { test, expect } from "./isolated-test";
import { getApprovalRequest } from "../src/lib/agents/registry";
import { ensureCreationsSchema, createCreation } from "../src/lib/creations/store";
import { createMission, missionToolHandlers } from "../src/lib/creations/missions";
import { proposeStep } from "../src/lib/creations/execution";
import { createSandbox } from "../src/lib/creations/store";

test.describe.configure({ mode: "serial" });
let slug = "";

test("steps: propose, approve into Tasks / approval queue, mark done, decline; validation", async ({ request }) => {
  slug = (await (await request.post("/api/creations", { data: { title: "E2E Execution Lab" } })).json()).creation.slug;
  const url = `/api/creations/${slug}/steps`;
  const post = (data: unknown) => request.post(url, { data });

  // Validation
  expect((await post({ kind: "launch_rocket", title: "x" })).status()).toBe(400);
  expect((await post({ kind: "email", title: "x", payload: { to: "not-an-email", subject: "s", body: "b" } })).status()).toBe(400);
  expect((await post({ kind: "meeting", title: "x", payload: { start: "2026-12-01T10:00:00-06:00", end: "2026-12-01T09:00:00-06:00" } })).status()).toBe(400);

  // Task → Tasks
  const task = (await (await post({ kind: "task", title: "E2E get zoning rules", details: "call the county", payload: { due_date: "2026-12-01" } })).json()).step;
  expect(task.status).toBe("proposed");
  const approvedTask = (await (await request.post(`/api/creations/steps/${task.id}`, { data: { action: "approve" } })).json()).step;
  expect(approvedTask.status).toBe("approved");
  expect(approvedTask.result).toMatch(/Added to Tasks \(#\d+\)/);
  const taskId = Number(/#(\d+)/.exec(approvedTask.result)![1]);
  const tasks = (await (await request.get("/api/tasks?status=all&category=The%20Creation")).json()).tasks as { id: number; title: string }[];
  expect(tasks.find((t) => t.id === taskId)?.title).toBe("E2E get zoning rules");
  const done = (await (await request.post(`/api/creations/steps/${task.id}`, { data: { action: "done" } })).json()).step;
  expect(done.status).toBe("done");

  // Meeting → a PENDING calendar_create request (no invite is sent)
  const mtg = (await (await post({ kind: "meeting", title: "E2E planner call", payload: { start: "2026-12-02T10:00:00-06:00", end: "2026-12-02T10:30:00-06:00", attendees: ["planner@example.com"] } })).json()).step;
  const mres = (await (await request.post(`/api/creations/steps/${mtg.id}`, { data: { action: "approve" } })).json()).step;
  expect(mres.result).toMatch(/Calendar request #\d+ is waiting in the approval queue/);
  const reqId = Number(/#(\d+)/.exec(mres.result)![1]);
  const ar = getApprovalRequest(reqId)!;
  expect(ar.action).toBe("calendar_create");
  expect(ar.status).toBe("pending");

  // Email → fails safely when no mail account is connected (and never sends)
  const em = (await (await post({ kind: "email", title: "E2E intro", payload: { to: "someone@example.com", subject: "Hello", body: "Hi" } })).json()).step;
  const eres = (await (await request.post(`/api/creations/steps/${em.id}`, { data: { action: "approve" } })).json()).step;
  expect(["failed", "approved"]).toContain(eres.status);
  if (eres.status === "approved") expect(eres.result).toMatch(/Draft #\d+ is in Communications/);
  else expect(eres.result).toMatch(/mail account/);

  // Edit while proposed, then decline
  const man = (await (await post({ kind: "manual", title: "E2E visit parcels" })).json()).step;
  const edited = (await (await request.post(`/api/creations/steps/${man.id}`, { data: { action: "edit", details: "three in North Columbia" } })).json()).step;
  expect(edited.title).toBe("E2E visit parcels");
  expect(edited.details).toBe("three in North Columbia");
  const dec = (await (await request.post(`/api/creations/steps/${man.id}`, { data: { action: "decline" } })).json()).step;
  expect(dec.status).toBe("declined");
  expect((await request.post(`/api/creations/steps/${man.id}`, { data: { action: "approve" } })).status()).toBe(400);
});

test("collaborators propose but can't approve; only the Producer agent can propose as an agent", async ({ request }) => {
  const inv = await (await request.post(`/api/creations/${slug}/members`, { data: { name: "E2E Collab Exec", role: "collaborator" } })).json();
  const base = `/c/${inv.token}/api/creations`;
  const st = (await (await request.post(`${base}/${slug}/steps`, { data: { kind: "manual", title: "E2E from collaborator" } })).json()).step;
  expect(st.created_by).toBe("e2e-collab-exec");
  expect((await request.post(`${base}/steps/${st.id}`, { data: { action: "approve" } })).status()).toBe(403);
  expect((await (await request.get(`${base}/${slug}/steps`)).json()).steps.length).toBeGreaterThan(0);

  await ensureCreationsSchema();
  expect(() => proposeStep(slug, { kind: "manual", title: "x" }, "agent:skeptic")).toThrow(/not found/);
  const sb = createSandbox(slug, { title: "E2E producer sb" }, "agent:producer", "agent");
  const h = missionToolHandlers({ slug, creationId: sb.creation_id, sandboxId: sb.id, actor: "agent:producer", missionId: 0, finished: { report: null } });
  expect(h.propose_step({ kind: "task", title: "E2E producer task" })).toMatch(/waits for Owner's approval/);
  expect(() => createMission(slug, { role: "producer", goal: "E2E draft the plan", when: "tonight" })).not.toThrow();
  void createCreation; // (imported for type parity with other specs)
});

test("phone: no sideways scrolling; work/feed switch; execution board works", async ({ browser, request }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, extraHTTPHeaders: (test.info().project.use as { extraHTTPHeaders?: Record<string, string> }).extraHTTPHeaders });
  const page = await ctx.newPage();
  await page.goto(`/the-creation/${slug}`);
  await expect(page.getByTestId("pane-work")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("artifact-pane")).toBeVisible();
  await page.getByTestId("pane-feed").click();
  await expect(page.getByTestId("creation-feed")).toBeVisible();
  await expect(page.getByTestId("artifact-pane")).toBeHidden();

  await page.getByTestId("pane-work").click();
  await page.getByTestId("view-execution").click();
  await expect(page.getByTestId("execution-board")).toBeVisible();
  await page.getByTestId("step-add").click();
  await page.getByTestId("step-kind-manual").click();
  await page.getByTestId("step-title").fill("E2E phone step");
  await page.getByTestId("step-submit").click();
  const card = page.getByTestId("exec-col-proposed").locator("li").filter({ hasText: "E2E phone step" });
  await expect(card).toBeVisible();
  await card.getByTestId("step-approve").click();
  await expect(page.getByTestId("exec-col-approved")).toContainText("E2E phone step");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await ctx.close();
  void request;
});
