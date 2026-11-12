import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";

// Mobile Files redesign + desktop Comments pill placement. Never presses Send or triggers an agent.

test.afterEach(() => cleanupFilesPages());

test("phone: bottom-left menu opens the tree drawer and controls are icon-only", async ({ page, request }) => {
  const { page: p } = await (await request.post("/api/files", { data: { title: `E2E Mobile ${Date.now()}`, body: "hello" } })).json();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`/files?id=${p.id}`);
  await expect(page.getByTestId("files-topbar")).toBeVisible({ timeout: 20_000 });

  await expect(page.getByTestId("files-panel")).toBeHidden();
  await page.getByTestId("files-mobile-menu").click();
  await expect(page.getByTestId("files-panel")).toBeVisible();
  const add = page.getByTestId("files-add-page");
  await expect(add).toBeVisible();
  await expect(add).toHaveAttribute("aria-label", "Add page");
  await expect(add).toHaveText("");

  await page.getByRole("link", { name: "Files", exact: true }).first().click();
  await expect(page.getByTestId("files-panel")).toBeHidden();

  await page.goto(`/files?id=${p.id}`);
  const menu = page.getByTestId("files-actions-menu");
  await expect(menu).toBeVisible({ timeout: 20_000 });
  await menu.click();
  const move = page.getByTestId("files-actions-list").getByRole("button", { name: "Move", exact: true });
  await expect(move).toBeVisible();
  await expect(move).toHaveText(/Move/);
});

test("desktop: Comments pill stays in the top bar", async ({ page, request }) => {
  const { page: p } = await (await request.post("/api/files", { data: { title: `E2E Desktop ${Date.now()}`, body: "hello" } })).json();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/files?id=${p.id}`);
  await expect(page.getByTestId("files-topbar")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("files-mobile-menu")).toBeHidden();
  await expect(page.getByTestId("files-topbar").getByTestId("file-comments-slot")).toBeAttached({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Move", exact: true })).toHaveAttribute("aria-label", "Move");
});
