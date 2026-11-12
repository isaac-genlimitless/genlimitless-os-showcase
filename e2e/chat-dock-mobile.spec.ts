import { test, expect } from "@playwright/test";

// Chat dock must not auto-open on phones. Never presses Send or triggers an agent.

const seed = () => localStorage.setItem("os.chatDock", JSON.stringify({ open: true, width: 420 }));

test("phone: persisted open dock stays closed until Ask Chief is tapped", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(seed);
  await page.goto("/files");
  await expect(page.getByTestId("chat-dock-open")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-dock")).toHaveCount(0);

  await page.getByTestId("chat-dock-open").click();
  await expect(page.getByTestId("chat-dock")).toBeVisible();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("os.chatDock") || "{}"));
  expect(stored.open).toBe(false);
});

test("desktop: persisted open dock opens on load", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(seed);
  await page.goto("/files");
  await expect(page.getByTestId("chat-dock")).toBeVisible({ timeout: 15_000 });
});
