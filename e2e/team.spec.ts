import { test, expect } from "./isolated-test";

// Team page: the org chart, Owner's controls over agents, and the approval queue.
// Mutates agent rows, so it only runs on the isolated server. Never triggers an agent.

test("Team page shows the Chief of Staff and its core reports", async ({ page }) => {
  await page.goto("/team");
  await expect(page.getByTestId("agent-chief_of_staff")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-chief_of_staff")).toContainText("Chief");
  await expect(page.getByTestId("agent-marketing_director")).toHaveCount(0); // retired with school outreach
  await expect(page.getByTestId("agent-full_stack_engineer")).toBeVisible();
  await expect(page.getByRole("link", { name: "Team" })).toBeVisible();
});

test("Owner can teach an agent and edit its instructions; every change is logged", async ({ page, request }) => {
  const lesson = `E2E lesson ${Date.now()}`;
  await page.goto("/team");
  const card = page.getByTestId("agent-full_stack_engineer");
  await card.getByRole("button", { name: /Details/ }).click();
  await card.getByPlaceholder(/Teach Full Stack Engineer/).fill(lesson);
  await card.getByRole("button", { name: "Add" }).click();
  await expect(card.getByText(lesson)).toBeVisible({ timeout: 10_000 });

  const instructions = `E2E instructions ${Date.now()}`;
  await card.getByRole("button", { name: "Edit instructions" }).click();
  await card.locator("textarea").nth(2).fill(instructions);
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText(instructions)).toBeVisible({ timeout: 10_000 });

  const data = await (await request.get("/api/agents")).json();
  expect(data.changes.some((c: any) => c.agent_slug === "full_stack_engineer" && c.field === "instructions" && c.changed_by === "owner")).toBeTruthy();
});

test("core agents can't be retired", async ({ request }) => {
  const res = await request.post("/api/agents", { data: { action: "retire_agent", slug: "full_stack_engineer" } });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toMatch(/can't be retired/);
});

test("agents' text drafts never auto-send, even to an allowlisted handle", async ({ request }) => {
  const handle = `+1555${Date.now().toString().slice(-7)}`;
  await request.post("/api/text-drafts/allowlist", { data: { handle, label: "E2E" } });
  const res = await request.post("/api/text-drafts", { data: { to: handle, text: "E2E never sent", reason: "e2e" } });
  expect((await res.json()).status).toBe("pending_approval");
});
