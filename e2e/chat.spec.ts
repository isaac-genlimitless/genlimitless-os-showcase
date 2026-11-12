import { test, expect } from "@playwright/test";

// These tests never press Send — they must not trigger the agent or message anyone.

test("attaching a file shows it above the composer, and it can be removed", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "e2e-probe.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("probe"),
  });
  const chip = page.getByText("e2e-probe.txt");
  await expect(chip).toBeVisible();
  await chip.locator("..").getByRole("button", { name: "✕" }).click();
  await expect(chip).toHaveCount(0);
});

test("attaching two files keeps both", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") },
    { name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("b") },
  ]);
  await expect(page.getByText("a.txt")).toBeVisible();
  await expect(page.getByText("b.txt")).toBeVisible();
});

test("chat history loads", async ({ page }) => {
  const res = await page.request.get("/api/chat");
  expect(res.ok()).toBeTruthy();
  expect(Array.isArray((await res.json()).messages)).toBeTruthy();
});
