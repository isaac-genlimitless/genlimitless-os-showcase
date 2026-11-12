import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";

// Files sidebar hide/show + static top bar. Never presses Send or triggers an agent.

test.afterEach(() => cleanupFilesPages());

test("sidebar toggle persists and the top bar stays put while the page scrolls", async ({ page, request }) => {
  const body = Array.from({ length: 120 }, (_, i) => `Line ${i} of a long page.`).join("\n\n");
  const { page: p } = await (await request.post("/api/files", { data: { title: `E2E Sidebar ${Date.now()}`, body } })).json();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/files?id=${p.id}`);
  await expect(page.getByTestId("files-panel")).toBeVisible();

  const toggle = page.getByTestId("files-sidebar-toggle");
  await toggle.click();
  await expect(page.getByTestId("files-panel")).toBeHidden();
  await expect(toggle).toHaveAttribute("title", "Show sidebar");
  expect(await page.evaluate(() => localStorage.getItem("os.files.sidebar"))).toBe("0");

  await page.reload();
  await expect(page.getByTestId("files-topbar")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("files-panel")).toBeHidden();

  await expect(page.getByTestId("share-menu")).toBeVisible({ timeout: 20_000 });
  const before = await page.getByTestId("files-topbar").boundingBox();
  await page.getByTestId("files-scroller").evaluate((el) => { el.scrollTop = 1500; });
  const after = await page.getByTestId("files-topbar").boundingBox();
  expect(after?.y).toBe(before?.y);
  await expect(page.getByTestId("share-menu")).toBeVisible();
  await expect(page.getByTestId("download-menu")).toBeVisible();
  await expect(page.getByRole("button", { name: "Move", exact: true })).toBeVisible();

  await toggle.click();
  await expect(page.getByTestId("files-panel")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("os.files.sidebar"))).toBe("1");
});
