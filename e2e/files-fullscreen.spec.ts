import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";

// Files full-screen (focus) mode. Never presses Send or triggers an agent; only opens/closes the chat panel.

test.afterEach(() => cleanupFilesPages());

const unique = (label: string) => `E2E ${label} ${Date.now()}`;

test("full screen hides every side panel, keeps the Ask Chief button, keeps editing/autosave, and exit restores the layout", async ({ page, request }) => {
  const { page: p } = await (await request.post("/api/files", { data: { title: unique("Focus"), body: "Original content." } })).json();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/files?id=${p.id}`);
  const editor = page.locator(".bn-editor");
  await expect(editor.getByText("Original content.")).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("chat-dock-open").click();
  await expect(page.getByTestId("chat-dock")).toBeVisible();
  await expect(page.locator("aside[data-app-nav]")).toBeVisible();
  await expect(page.getByTestId("files-panel")).toBeVisible();

  const toggle = page.getByTestId("files-fullscreen-toggle");
  await expect(toggle).toHaveAttribute("title", "Full screen");
  await toggle.click();
  await expect(page.locator("aside[data-app-nav]")).toBeHidden();
  await expect(page.getByTestId("files-panel")).toBeHidden();
  await expect(page.getByTestId("chat-dock")).toBeHidden();
  await expect(page.getByTestId("chat-dock-open")).toBeVisible();
  await expect(toggle).toHaveAttribute("title", "Exit full screen");

  await editor.getByText("Original content.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Typed in focus.");
  await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });
  const saved = await (await request.get(`/api/files/${p.id}`)).json();
  expect(saved.page.body).toContain("Original content. Typed in focus.");

  await page.getByTestId("chat-dock-open").click();
  await expect(page.getByTestId("chat-dock")).toBeVisible();
  await expect(page.getByTestId("files-panel")).toBeHidden();
  await page.keyboard.press("Control+j");
  await expect(page.getByTestId("chat-dock")).toBeHidden();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("files-panel")).toBeVisible();
  await expect(page.locator("aside[data-app-nav]")).toBeVisible();
  await expect(page.getByTestId("chat-dock")).toBeVisible();
  await expect(toggle).toHaveAttribute("title", "Full screen");
  await expect(editor.getByText("Original content. Typed in focus.")).toBeVisible();
});

test("exit button restores panels", async ({ page, request }) => {
  const { page: p } = await (await request.post("/api/files", { data: { title: unique("Exit"), body: "Some content." } })).json();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/files?id=${p.id}`);
  await expect(page.locator(".bn-editor").getByText("Some content.")).toBeVisible({ timeout: 20_000 });
  const toggle = page.getByTestId("files-fullscreen-toggle");
  await toggle.click();
  await expect(page.getByTestId("files-panel")).toBeHidden();
  await expect(toggle).toHaveAttribute("title", "Exit full screen");
  await toggle.click();
  await expect(page.getByTestId("files-panel")).toBeVisible();
});

test("mobile width: the full-screen toggle is hidden on phones", async ({ page, request }) => {
  const { page: p } = await (await request.post("/api/files", { data: { title: unique("Mobile"), body: "Mobile content." } })).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/files?id=${p.id}`);
  await expect(page.locator(".bn-editor").getByText("Mobile content.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("files-fullscreen-toggle")).toBeHidden();
});
