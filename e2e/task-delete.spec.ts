import { test, expect } from "@playwright/test";

// Task delete (soft delete via archived_at). Never presses Send and never triggers an agent.

const isolated = !!process.env.E2E_START_SERVER;
const stamp = Date.now();

test("Delete asks for confirmation and Cancel changes nothing", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  const deletes = page.getByTestId("task-delete");
  const count = await deletes.count();
  test.skip(count === 0, "no tasks to test against");
  await deletes.first().click();
  await expect(page.getByText("Delete this task?")).toBeVisible();
  await expect(page.getByTestId("task-delete-confirm")).toBeVisible();
  await page.getByTestId("task-delete-cancel").click();
  await expect(page.getByText("Delete this task?")).toHaveCount(0);
  await expect(page.getByTestId("task-delete")).toHaveCount(count);
});

test("deleting a task soft-deletes it", async ({ page, request }) => {
  test.skip(!isolated, "writes real data: only runs under `npm run test:e2e:branch`");
  const title = `E2E Delete ${stamp}`;
  const created = await (await request.post("/api/tasks", { data: { title } })).json();
  const id = (created.task ?? created).id;
  await page.goto("/tasks");
  const row = page.locator("li", { hasText: title });
  await expect(row).toHaveCount(1);
  await row.getByTestId("task-delete").click();
  await row.getByTestId("task-delete-confirm").click();
  await expect(page.locator("li", { hasText: title })).toHaveCount(0);

  const { tasks } = await (await request.get("/api/tasks?status=all")).json();
  expect(tasks.some((t: any) => t.id === id)).toBe(false);
  const got = await request.get(`/api/tasks/${id}`);
  expect(got.status()).toBe(200);
  const body = await got.json();
  expect((body.task ?? body).archived_at).toBeTruthy();

  expect((await request.post("/api/tasks/999999/remove")).status()).toBe(404);
  expect((await request.post("/api/tasks/abc/remove")).status()).toBe(400);
  expect((await request.delete(`/api/tasks/${id}`)).status()).toBe(405);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("Delete button is a 44px tap target and the row stays on screen", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
    const btn = page.getByTestId("task-delete").first();
    test.skip((await page.getByTestId("task-delete").count()) === 0, "no tasks to test against");
    const box = await btn.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});
