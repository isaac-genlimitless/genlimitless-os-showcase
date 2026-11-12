import { test, expect } from "@playwright/test";

// Tasks tab. The read-only test runs anywhere. Tests that write use "E2E ..." titles, which the
// live server refuses, so they only run under `npm run test:e2e:branch` (isolated data dir).
// Never presses Send and never triggers an agent.

const isolated = !!process.env.E2E_START_SERVER;
const stamp = Date.now();

const SEEDED = ["Renew license", "Amazon returns", "Cancel unused subscription", "CarrierCo switches", "Reply to the neighbor", "Health insurance call", "Life insurance call", "Update address"];

test("Tasks page loads and its sidebar link is active", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await expect(page.locator("aside nav").getByRole("link", { name: "Tasks", exact: true })).toHaveClass(/text-accent/);
  await expect(page.getByTestId("task-add")).toBeVisible();
});

test("the 8 Personal Admin tasks are seeded, open, with no due date", async ({ request }) => {
  test.skip(!isolated, "live tasks may have been edited since the seed; checked on the isolated run only");
  const { tasks } = await (await request.get("/api/tasks?status=all")).json();
  for (const title of SEEDED) {
    const matches = tasks.filter((t: any) => t.title === title);
    expect(matches, title).toHaveLength(1);
    expect(matches[0].category).toBe("Personal Admin");
    expect(matches[0].due_date).toBeNull();
    expect(matches[0].status).toBe("open");
  }
});

test("add, edit, complete and reopen a task from the UI", async ({ page, request }) => {
  test.skip(!isolated, "writes real data: only runs under `npm run test:e2e:branch`");
  const title = `E2E Task ${stamp}`;
  const renamed = `E2E Task renamed ${stamp}`;
  await page.goto("/tasks");

  const form = page.getByTestId("task-add");
  await form.getByPlaceholder("Add a task…").fill(title);
  await form.getByLabel("Priority").selectOption("high");
  await form.getByLabel("Due date").fill("2026-10-05");
  await form.getByRole("button", { name: "Add task" }).click();

  let row = page.getByTestId("task-row").filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row.getByText("High", { exact: true })).toBeVisible();
  await expect(row.getByText("Oct 5")).toBeVisible();

  await row.getByRole("button", { name: "Edit" }).click();
  await row.getByLabel("Title").fill(renamed);
  await row.getByRole("button", { name: "Save" }).click();
  row = page.getByTestId("task-row").filter({ hasText: renamed });
  await expect(row).toBeVisible();

  const { tasks } = await (await request.get("/api/tasks?status=all")).json();
  const id = tasks.find((t: any) => t.title === renamed).id;

  await row.getByLabel("Mark done").check();
  await expect(page.getByTestId("task-row").filter({ hasText: renamed }).getByLabel("Reopen")).toBeChecked();
  let t = (await (await request.get(`/api/tasks/${id}`)).json()).task;
  expect(t.status).toBe("done");
  expect(t.completed_at).toBeTruthy();

  await page.getByTestId("task-row").filter({ hasText: renamed }).getByLabel("Reopen").uncheck();
  await expect(page.getByTestId("task-row").filter({ hasText: renamed }).getByLabel("Mark done")).not.toBeChecked();
  t = (await (await request.get(`/api/tasks/${id}`)).json()).task;
  expect(t.status).toBe("open");
  expect(t.completed_at).toBeNull();
});

test("the API validates input and has no delete", async ({ request }) => {
  test.skip(!isolated, "writes real data: only runs under `npm run test:e2e:branch`");
  expect((await request.post("/api/tasks", { data: { title: "" } })).status()).toBe(400);
  expect((await request.post("/api/tasks", { data: { title: "E2E x", priority: "urgent" } })).status()).toBe(400);

  const created = await request.post("/api/tasks", { data: { title: `E2E Validate ${stamp}` } });
  expect(created.status()).toBe(201);
  const id = (await created.json()).task.id;
  expect((await request.patch(`/api/tasks/${id}`, { data: { due_date: "2026-13-45" } })).status()).toBe(400);
  expect((await request.delete(`/api/tasks/${id}`)).status()).toBe(405);
  expect((await request.get(`/api/tasks/${id}`)).status()).toBe(200);
});

test("task functions used by the agent tools: create, complete, list, reject bad dates", async () => {
  test.skip(!isolated, "opens the database directly: only runs under `npm run test:e2e:branch`");
  const { createTask, updateTask, listTasks } = await import("../src/lib/tasks");
  const t = createTask({ title: `E2E Agent Task ${stamp}`, priority: "low", due_date: "2026-11-01" }, "agent:test");
  expect(t.created_by).toBe("agent:test");
  expect(updateTask(t.id, { status: "done" }).completed_at).toBeTruthy();
  expect(listTasks({ status: "done" }).some((x) => x.id === t.id)).toBe(true);
  expect(listTasks().some((x) => x.id === t.id)).toBe(false);
  expect(() => createTask({ title: "E2E bad date", due_date: "2026-02-30" })).toThrow();
  expect(() => updateTask(t.id, { due_date: "tomorrow" })).toThrow();
  expect(() => updateTask(999999, { title: "x" })).toThrow("task not found");
});

test.describe("Tasks page on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("no sideways scroll, rows stay inside the screen, tap targets are 44px", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page.getByTestId("task-add")).toBeVisible();
    await page.waitForLoadState("networkidle");
    const m = await page.evaluate(() => ({ docW: document.documentElement.scrollWidth, inner: window.innerWidth, mainS: document.querySelector("main")?.scrollWidth ?? 0, mainC: document.querySelector("main")?.clientWidth ?? 0 }));
    expect(m.docW).toBeLessThanOrEqual(m.inner);
    expect(m.mainS).toBeLessThanOrEqual(m.mainC);
    const addBtn = await page.getByTestId("task-add").getByRole("button", { name: "Add task" }).boundingBox();
    expect(addBtn!.height).toBeGreaterThanOrEqual(44);
    const rows = page.getByTestId("task-row");
    test.skip((await rows.count()) === 0, "no tasks to measure");
    const row = rows.first();
    const rb = await row.boundingBox();
    expect(rb!.x + rb!.width).toBeLessThanOrEqual(390);
    const cb = await row.locator("label").first().boundingBox();
    expect(cb!.width).toBeGreaterThanOrEqual(44);
    expect(cb!.height).toBeGreaterThanOrEqual(44);
    const edit = await row.getByRole("button", { name: "Edit" }).boundingBox();
    expect(edit!.height).toBeGreaterThanOrEqual(44);
  });
});

// Finished-task check. We never click it (that would start a Chief run); only that it is there and
// that the status endpoint answers.
test("Tasks page has the 'Check for finished tasks' button and its status route answers", async ({ page, request }) => {
  await page.goto("/tasks");
  await expect(page.getByTestId("task-reconcile")).toBeVisible();
  await expect(page.getByTestId("task-reconcile")).toBeEnabled();
  const r = await request.get("/api/tasks/reconcile");
  expect(r.status()).toBe(200);
  expect(await r.json()).toHaveProperty("last_ok");
});
