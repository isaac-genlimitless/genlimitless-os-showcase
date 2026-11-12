import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";

// Mobile Files drawer can be closed (X and tap-outside); action buttons are icon-only with labels.
// Never presses Send or triggers an agent.

test.afterEach(() => cleanupFilesPages());

test("phone: drawer closes with X and by tapping the backdrop; topbar buttons are icon-only", async ({ page, request }) => {
  const { page: p } = await (await request.post("/api/files", { data: { title: `E2E Drawer ${Date.now()}`, body: "hello" } })).json();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`/files?id=${p.id}`);
  await expect(page.getByTestId("files-topbar")).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("files-mobile-menu").click();
  await expect(page.getByTestId("files-panel")).toBeVisible();
  await page.getByTestId("files-drawer-close").click();
  await expect(page.getByTestId("files-panel")).toBeHidden();

  await page.getByTestId("files-mobile-menu").click();
  await expect(page.getByTestId("files-panel")).toBeVisible();
  await page.getByTestId("files-drawer-backdrop").click({ position: { x: 380, y: 400 } });
  await expect(page.getByTestId("files-panel")).toBeHidden();

  const menu = page.getByTestId("files-actions-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("aria-label", "More actions");
  await menu.click();
  const list = page.getByTestId("files-actions-list");
  for (const name of ["Share", "Download", "Move", "Move to Trash"]) {
    await expect(list.getByRole("button", { name, exact: true })).toBeVisible();
  }
});
