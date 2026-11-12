import { test, expect } from "./isolated-test";
import cron from "node-cron";
import { startScheduler, __resetSchedulerForTests } from "../src/lib/scheduler";
import { markDailyScheduleRan, markRan, EVENING_SHUTDOWN_JOB } from "../src/lib/schedule";
import { systemPromptFor } from "../src/lib/agents/runtime";
import { listAgents } from "../src/lib/agents/registry";
import { allTools, assignableCatalog, toolNames } from "../src/lib/agents/tools";
import { internalTokenFor } from "../src/lib/auth/policy";
import { createUser, getUser } from "../src/lib/accounts/users";
import { createSession } from "../src/lib/auth/store";

// Member mode (docs/multi-user.md): a cell with GLOS_ROLE=member hides and 404s everything that touches the shared
// code, the server or the owner's personal bridges, never starts those cron jobs, and never says "Owner".
// The member server (:3210, see playwright.config.ts) runs on throwaway data with the scheduler off.
// Nothing here presses Send or triggers an agent.
const MEMBER = `http://localhost:${process.env.E2E_MEMBER_PORT || 3210}`;
// A member cell always requires a real session of its own user, checked by asking the owner server (docs/multi-user.md
// "Request flow"). The runner shares the harness's throwaway ACCOUNTS_DIR with the owner server, so create the member
// user and a session there and send it as a cookie. The owner token playwright.config.ts sends by default is replaced
// with the member cell's own one (a cell accepts only its own loopback token).
function memberSessionToken(): string {
  if (!getUser("partner")) createUser({ id: "partner", display_name: "Partner", role: "member" });
  return createSession("partner", { ip: "127.0.0.1", userAgent: "e2e member-mode", method: "test" }).token;
}
test.use({
  baseURL: MEMBER,
  extraHTTPHeaders: {
    "x-glos-internal": internalTokenFor("partner", process.env.E2E_MEMBER_DATA_DIR),
    cookie: `glos_session=${memberSessionToken()}`,
  },
});
test.setTimeout(120_000);

const OWNER_ONLY_GET = [
  "/api/deploy", "/api/github", "/api/ops", "/api/server-health", "/api/disk-usage", "/api/cleanup", "/api/code-map",
  "/api/bridge-status", "/api/imessage", "/api/imessage?chat=1", "/api/imessage?q=abc", "/api/job-engine/overview", "/api/job-engine/applications",
  "/api/job-engine/instructions", "/api/jd-queue", "/api/linkedin-conversations", "/api/analytics/jobs",
  "/api/analytics/linkedin", "/api/birthday", "/api/text-drafts", "/api/text-drafts/allowlist", "/api/issues", "/api/schools",
  "/api/dreamhouse", "/api/farmhouse/refined", "/api/job-engine/analytics", "/api/job-engine/company-stages",
];

test("every owner-only API route returns 404 in a member cell", async ({ request }) => {
  for (const path of OWNER_ONLY_GET) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
  }
  // Writes: 404 before the handler runs (nothing is cleaned, scanned, queued or sent).
  for (const path of ["/api/cleanup/scan", "/api/job-engine/runs", "/api/job-engine/inbox", "/api/text-drafts", "/api/ops"]) {
    const res = await request.post(path, { data: {} });
    expect(res.status(), `POST ${path}`).toBe(404);
  }
});

test("per-user routes still work in a member cell", async ({ request }) => {
  for (const path of ["/api/health", "/api/tasks", "/api/agents", "/api/email-drafts"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBeLessThan(400);
  }
  // Email search lives on the /api/imessage route (scope=email); it must keep working for members.
  expect((await request.get("/api/imessage?q=abc&scope=email")).status()).toBe(200);
});

test("a member's fresh database gets none of the owner's seeded content", async ({ request }) => {
  // db.ts, creations/store.ts, linkedin-convos.ts and scheduled-texts.ts seed Owner's own tasks, campaign, Creation
  // canon, LinkedIn notes and a reminder on first run. In a member cell those seeds must not run.
  const tasks = await (await request.get("/api/tasks")).text();
  for (const t of ["Renew license", "Reply to the neighbor", "Update address", "Health insurance call"]) expect(tasks, t).not.toContain(t);
  expect(await (await request.get("/api/creations")).text()).not.toMatch(/Starting canon/);
  // The Full Stack Engineer works on the shared OS code: owner only, so a member's team is just the Chief of Staff.
  const team = (await (await request.get("/api/agents")).json()) as { agents: { slug: string; status: string; tools: string[] }[] };
  const active = team.agents.filter((a) => a.status === "active");
  expect(active.map((a) => a.slug)).not.toContain("full_stack_engineer");
  // ...and the Team page lists only tools that exist in a member cell (no texting Owner, no job engine, no PRs).
  const tools = active.flatMap((a) => a.tools);
  for (const t of ["text_owner", "schedule_text_owner", "jd_queue_list", "get_pr_status", "review_fix_proposal"]) {
    expect(tools, t).not.toContain(t);
  }
  expect(tools).toContain("create_task");
});

test("owner-only pages 404 and nav items are absent", async ({ page }) => {
  for (const path of ["/job-engine", "/birthday-admin", "/linkedin-conversations", "/software-dev"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
  }
  await page.goto("/today");
  const hrefs = await page.locator("aside[data-app-nav] a").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(hrefs).toContain("/files");
  expect(hrefs).toContain("/settings");
  expect(hrefs).not.toContain("/job-engine");
  expect(hrefs).not.toContain("/birthday-admin");
  await expect(page.locator("aside[data-app-nav]")).not.toContainText(/Job Engine|Partner admin/);
});

test("Settings and Communications hide owner-only tabs and cards", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.locator("h1", { hasText: "Settings" })).toBeVisible();
  const body = page.locator("body");
  await expect(body).not.toContainText(/Code Map|Cleanup candidates|Run ops review|Server health|Disk usage/i);
  await page.goto("/communications");
  await expect(page.getByTestId("email-tab")).toBeVisible();
  for (const t of ["inbox", "jobs", "linkedin"]) await expect(page.getByTestId(`${t}-tab`)).toHaveCount(0);
});

test('no visible page text says "Owner"', async ({ page }) => {
  for (const path of ["/", "/today", "/decisions", "/files", "/the-creation", "/calendar", "/tasks", "/budgets", "/meetings", "/team", "/communications", "/settings"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const text = await page.locator("body").innerText();
    expect(text, path).not.toMatch(/Owner/);
  }
  for (const path of ["/api/agents", "/api/today", "/api/decisions", "/api/tasks", "/api/runs"]) {
    const res = await page.request.get(path);
    expect(res.status(), path).toBeLessThan(400);
    expect(await res.text(), path).not.toMatch(/Owner/);
  }
  const html = await (await page.goto("/today"))!.text();
  expect(html).not.toMatch(/Owner/); // metadata/description too
});

test('agent prompts and tool descriptions never say "Owner" and owner-only tools are absent (member cell)', async () => {
  const prev = { r: process.env.GLOS_ROLE, n: process.env.GLOS_DISPLAY_NAME };
  process.env.GLOS_ROLE = "member";
  process.env.GLOS_DISPLAY_NAME = "Partner";
  try {
    const agents = listAgents(true);
    expect(agents.length).toBeGreaterThan(0);
    for (const a of agents) {
      const prompt = systemPromptFor(a);
      expect(prompt, `prompt for ${a.slug}`).not.toMatch(/Owner/);
      expect(prompt).toContain("Partner");
    }
    const tools = allTools();
    const names = new Set(tools.map((t) => t.name));
    for (const t of tools) expect(t.description ?? "", t.name).not.toMatch(/Owner/);
    for (const g of ["engineering", "direct_owner", "sched_texts", "texts"] as const)
      for (const n of toolNames(g)) expect(names.has(n), `${g}/${n}`).toBe(false);
    for (const c of assignableCatalog()) expect(c.description).not.toMatch(/Owner/);
    expect(names.has("create_task") || names.has("list_tasks")).toBe(true); // per-user tools remain
  } finally {
    if (prev.r === undefined) delete process.env.GLOS_ROLE; else process.env.GLOS_ROLE = prev.r;
    if (prev.n === undefined) delete process.env.GLOS_DISPLAY_NAME; else process.env.GLOS_DISPLAY_NAME = prev.n;
  }
});

test("a member cell's scheduler registers only per-user cron jobs", async () => {
  // Pre-mark the catch-up jobs as done so startScheduler's immediate startup checks can never launch an agent run.
  markDailyScheduleRan();
  markRan(EVENING_SHUTDOWN_JOB);
  markRan("weekly_review");
  const calls: { expr: string; src: string }[] = [];
  const orig = cron.schedule;
  const origTimeout = global.setTimeout;
  const prev = process.env.GLOS_ROLE;
  (cron as unknown as { schedule: unknown }).schedule = (expr: string, fn: unknown) => {
    calls.push({ expr, src: String(fn) });
    return { stop() {}, start() {} };
  };
  (global as unknown as { setTimeout: unknown }).setTimeout = () => 0; // boot-time timers never fire
  process.env.GLOS_ROLE = "member";
  __resetSchedulerForTests();
  try {
    startScheduler();
  } finally {
    (cron as unknown as { schedule: unknown }).schedule = orig;
    global.setTimeout = origTimeout;
    if (prev === undefined) delete process.env.GLOS_ROLE; else process.env.GLOS_ROLE = prev;
    __resetSchedulerForTests();
  }
  const has = (needle: string) => calls.some((c) => c.src.includes(needle));
  // Owner-only (self-build, server ops, iMessage, job-engine, LinkedIn, owner texts) must not be registered.
  for (const gone of ["fix-retry", "verifyIMessageDeliveries", "runScheduledTextsTick", "syncPullRequests", "linkedin-monitor", "checkDiskHealth", "checkServerHealthAlerts", "runReleaseCleanup", "runOpsReview", "nightlySelfTest", "runOwnerTextsTick", "runIndexer"])
    expect(has(gone), gone).toBe(false);
  // Per-user jobs stay.
  for (const kept of ["retryApprovedDrafts", "runMailHealthProbe", "runEmailWatchdogTick", "runBriefing", "runImprovementReview", "runAutopilotTick", "runCapturesTick", "runChiefMentionsTick", "agentSchedulesTick", "runSpellfixTick", "runTaskReconcile"])
    expect(has(kept), kept).toBe(true);
});
