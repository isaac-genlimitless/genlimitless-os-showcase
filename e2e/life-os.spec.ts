import { test, expect } from "@playwright/test";
import db from "../src/lib/db";
import { createCapture, getCapture, processCapture, processPendingCaptures } from "../src/lib/captures";
import { listDecisions } from "../src/lib/decisions";
import "../src/lib/email-drafts"; // creates the email_drafts table
import { maybeScheduleAutopilot, turnOnAutopilot } from "../src/lib/autopilot";
import { CORE_AGENTS, GUARDRAILS } from "../src/lib/agents/charters";

// Today page, Decisions queue, capture inbox. UI tests are read-only (they never press Send,
// Approve, Capture or anything that would message someone or start an agent). Writing tests use
// the runner's throwaway DB or run only on the isolated server.

const isolated = !!process.env.E2E_START_SERVER;

test("capture inbox: filed by Chief (fake runner), failures retry up to 3 times", async () => {
  const c = createCapture({ text: `renew passport before March ${Date.now()}` });
  expect(c.status).toBe("new");
  const prompts: string[] = [];
  const done = await processCapture(c.id, async (p) => (prompts.push(p), "Task: Renew passport, due Mar 1 (/tasks?id=1)"));
  expect(done!.status).toBe("filed");
  expect(done!.result).toContain("Renew passport");
  expect(prompts[0]).toContain("CAPTURE");
  expect(prompts[0]).toContain("record_commitment");
  // Already filed: never re-run.
  await processCapture(c.id, async () => { throw new Error("should not run"); });
  expect(getCapture(c.id)!.status).toBe("filed");

  const bad = createCapture({ text: `flaky ${Date.now()}` });
  const boom = async () => { throw new Error("agent down"); };
  await processCapture(bad.id, boom);
  expect(getCapture(bad.id)!.status).toBe("failed");
  await processPendingCaptures(boom);
  await processPendingCaptures(boom);
  expect(getCapture(bad.id)!.attempts).toBe(3);
  await processPendingCaptures(async () => "should not run");
  expect(getCapture(bad.id)!.status).toBe("failed");
  expect(() => createCapture({ text: "  " })).toThrow();
});

test("decisions queue: pending drafts appear; an Autopilot draft is first with its send time", () => {
  // Rows straight into the throwaway DB (no mail account needed; nothing is ever sent).
  const ins = (to: string, subject: string) =>
    Number(db.prepare(`INSERT INTO email_drafts (account, to_addr, subject, body, created_by) VALUES ('nobody@example.test', ?, ?, 'hello', 'chief_of_staff')`).run(to, subject).lastInsertRowid);
  const plainId = ins("someone@example.test", "Plain");
  const who = `trusted-${Date.now()}@example.test`;
  turnOnAutopilot({ kind: "email", recipient: who, label: "Trusted" });
  const autoId = ins(who, "Auto");
  expect(maybeScheduleAutopilot("email", { id: autoId, recipient: who, body: `${who}\nAuto\nhello` })).toBeTruthy();
  const { items } = listDecisions();
  const a = items.find((i) => i.key === `email_draft:${autoId}`)!;
  const p = items.find((i) => i.key === `email_draft:${plainId}`)!;
  expect(a.autopilot_send_at).toBeTruthy();
  expect(p.autopilot_send_at).toBeUndefined();
  expect(p.autopilot_eligible?.recipient).toBe("someone@example.test");
  expect(items.indexOf(a)).toBeLessThan(items.indexOf(p));
});

test("guardrail text still says nothing goes out without approval, and names Autopilot as Owner-only", () => {
  expect(GUARDRAILS).toContain("NOTHING GOES OUT WITHOUT OWNER'S APPROVAL");
  expect(GUARDRAILS).toContain("Only Owner can turn it on");
  expect(CORE_AGENTS.chief_of_staff.hard).toContain("COMMITMENTS");
});

test("Today page loads with its sections and the capture box", async ({ page }) => {
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(page.locator("aside nav").getByRole("link", { name: "Today", exact: true })).toHaveClass(/text-accent/);
  await expect(page.getByTestId("capture-box")).toBeVisible();
  for (const id of ["today-needs-you", "today-calendar", "today-promises", "today-tasks", "today-captures"]) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId("commitment-add")).toBeVisible();
});

test("Today page fits a phone screen without sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/today");
  await expect(page.getByTestId("capture-box")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("Decisions page loads the queue and the Autopilot panel", async ({ page }) => {
  await page.goto("/decisions");
  await expect(page.getByRole("heading", { name: "Decisions", exact: true })).toBeVisible();
  await expect(page.locator("aside nav").getByRole("link", { name: "Decisions", exact: true })).toHaveClass(/text-accent/);
  await expect(page.getByTestId("decisions-list").or(page.getByTestId("decisions-empty"))).toBeVisible();
  await expect(page.getByTestId("autopilot-panel")).toBeVisible();
  await expect(page.getByTestId("autopilot-pause")).toBeVisible();
});

test("APIs: today, decisions, commitments, autopilot and captures read endpoints", async ({ request }) => {
  const today = await (await request.get("/api/today")).json();
  expect(today.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(today.commitments).toHaveProperty("waiting_on");
  const d = await (await request.get("/api/decisions")).json();
  expect(Array.isArray(d.items)).toBe(true);
  expect(d.autopilot).toHaveProperty("paused");
  expect(Array.isArray((await (await request.get("/api/commitments?status=all")).json()).commitments)).toBe(true);
  expect(Array.isArray((await (await request.get("/api/captures")).json()).captures)).toBe(true);
  const bad = await request.post("/api/autopilot", { data: { action: "turn_on", kind: "email", recipient: "a@x.test, b@x.test" } });
  expect(bad.status()).toBe(400);
});

test("add and close a promise from the Today page (isolated server only)", async ({ page, request }) => {
  test.skip(!isolated, "writes data: only under `npm run test:e2e:branch`");
  const what = `E2E promise ${Date.now()}`;
  await page.goto("/today");
  const form = page.getByTestId("commitment-add");
  await form.getByLabel("Person").fill("E2E Person");
  await form.getByLabel("Promise").fill(what);
  await form.getByLabel("Due").fill("2026-01-02"); // overdue, so it shows under "You owe"
  await form.getByRole("button", { name: "Add" }).click();
  const row = page.getByTestId("commitment-row").filter({ hasText: what });
  await expect(row).toBeVisible();
  const { commitments } = await (await request.get("/api/commitments?status=all")).json();
  const c = commitments.find((x: any) => x.what === what);
  expect(c.task_id).toBeTruthy();
  await row.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("commitment-row").filter({ hasText: what })).toHaveCount(0);
  const task = (await (await request.get(`/api/tasks/${c.task_id}`)).json()).task;
  expect(task.status).toBe("done");
});

test("a capture posted on the isolated server is stored and never starts an agent there", async ({ request }) => {
  test.skip(!isolated, "writes data: only under `npm run test:e2e:branch`");
  const r = await request.post("/api/captures", { multipart: { text: `E2E capture ${Date.now()}` } });
  expect(r.status()).toBe(201);
  const { capture } = await r.json();
  expect(capture.status).toBe("new"); // E2E_FIXTURES: filing is skipped on test servers
});
