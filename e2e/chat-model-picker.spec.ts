import { test, expect } from "@playwright/test";

// These tests never press Send — they must not trigger the agent or message anyone.

test("the chat has a model and effort picker that remembers the choice", async ({ page }) => {
  const chatPosts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/chat") chatPosts.push(req.url());
  });

  await page.goto("/");
  const model = page.getByTestId("chat-model");
  const effort = page.getByTestId("chat-effort");
  await expect(model).toHaveValue("");
  await expect(effort).toHaveValue("");

  await model.selectOption("claude-opus-5-5");
  await effort.selectOption("high");

  await page.reload();
  await expect(page.getByTestId("chat-model")).toHaveValue("claude-opus-5-5");
  await expect(page.getByTestId("chat-effort")).toHaveValue("high");

  // Haiku has no effort setting, so the effort picker switches off.
  await page.getByTestId("chat-model").selectOption("claude-haiku-4-5");
  await expect(page.getByTestId("chat-effort")).toBeDisabled();

  expect(chatPosts).toHaveLength(0);
});
