import { test, expect } from "@playwright/test";

// These tests never press Send — they must not trigger the agent or message anyone.

test("Shift+Enter inserts a new line instead of sending", async ({ page }) => {
  const chatPosts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/chat") {
      chatPosts.push(req.url());
    }
  });

  await page.goto("/");
  const box = page.getByPlaceholder(/Message Chief/);
  await box.click();
  await box.pressSequentially("line one");
  await box.press("Shift+Enter");
  await box.pressSequentially("line two");

  await expect(box).toHaveValue("line one\nline two");
  expect(chatPosts).toHaveLength(0);
});

test.describe("mobile composer", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("Enter inserts a newline on a phone and never sends", async ({ page }) => {
    const chatPosts: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && new URL(req.url()).pathname === "/api/chat") {
        chatPosts.push(req.url());
      }
    });
    await page.goto("/");
    const box = page.getByPlaceholder(/Message Chief/);
    await box.click();
    await box.pressSequentially("a");
    await box.press("Enter");
    await box.pressSequentially("b");
    await expect(box).toHaveValue("a\nb");
    expect(chatPosts).toHaveLength(0);
  });

  test("send button is arrow-only with an accessible name", async ({ page }) => {
    await page.goto("/");
    const send = page.getByTestId("send-btn");
    await expect(send).toHaveText("");
    await expect(send).toHaveAttribute("aria-label", "Send");
  });
});
