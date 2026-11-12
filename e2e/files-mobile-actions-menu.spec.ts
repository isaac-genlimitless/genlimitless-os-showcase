import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";

// Phone top bar: dead buttons hidden, actions in one "⋮" menu. Never presses Send or triggers an agent.

test.afterEach(() => cleanupFilesPages());

test("phone: actions live in the ⋮ menu and the breadcrumb keeps its space", async ({ page, request }) => {
  const { page: p } = await (await request.post("/api/files", { data: { title: `E2E MobileMenu ${Date.now()}`, body: "hello" } })).json();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`/files?id=${p.id}`);
  await expect(page.getByTestId("files-topbar")).toBeVisible({ timeout: 20_000 });

  await expect(page.getByTestId("files-sidebar-toggle")).toBeHidden();
  await expect(page.getByTestId("files-fullscreen-toggle")).toBeHidden();
  const menu = page.getByTestId("files-actions-menu");
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("share-menu")).toBeHidden();
  await expect(page.getByTestId("download-menu")).toBeHidden();
  await expect(page.getByRole("button", { name: "Move", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Trash", exact: true })).toBeHidden();

  const crumb = await page.getByTestId("files-breadcrumb").boundingBox();
  const kebab = await menu.boundingBox();
  expect(crumb!.width).toBeGreaterThanOrEqual(150);
  expect(crumb!.x + crumb!.width).toBeLessThanOrEqual(kebab!.x + 1);

  await menu.click();
  const list = page.getByTestId("files-actions-list");
  for (const name of ["Add to favorites", "Share", "Download", "Move", "Move to Trash"]) {
    await expect(list.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await list.getByRole("button", { name: "Add to favorites", exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/api/files/${p.id}`)).json()).page.favorite).toBeTruthy();
  await menu.click();
  await expect(list.getByRole("button", { name: "Remove from favorites", exact: true })).toBeVisible();

  await list.getByTestId("share-menu-mobile").click();
  await expect(page.getByTestId("share-toggle")).toBeVisible();
});

test("desktop: icon row is unchanged and the ⋮ menu is hidden", async ({ page, request }) => {
  const { page: p } = await (await request.post("/api/files", { data: { title: `E2E DesktopMenu ${Date.now()}`, body: "hello" } })).json();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/files?id=${p.id}`);
  await expect(page.getByTestId("files-topbar")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("files-sidebar-toggle")).toBeVisible();
  await expect(page.getByTestId("files-fullscreen-toggle")).toBeVisible();
  await expect(page.getByTestId("share-menu")).toBeVisible();
  await expect(page.getByTestId("download-menu")).toBeVisible();
  await expect(page.getByRole("button", { name: "Move", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Trash", exact: true })).toBeVisible();
  await expect(page.getByTestId("files-actions-menu")).toBeHidden();
});
