import { test, expect } from "./isolated-test";

// Side chats: open one next to Main, switch between them, close it (merges into Main).
// Never presses Send, so no agent runs.

test("a side chat opens as its own tab and closing it returns to Main", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("chat-tab-main")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "+ New chat" }).click();
  await expect(page.getByText(/Side chat\. Ask for anything while Main keeps working/)).toBeVisible();

  const threads = (await (await page.request.get("/api/chat/threads")).json()).threads;
  const id = threads.at(-1).id;
  await expect(page.getByTestId(`chat-tab-${id}`)).toBeVisible();

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: /^Close New chat/ }).last().click();
  await expect(page.getByTestId(`chat-tab-${id}`)).toHaveCount(0);
  const after = (await (await page.request.get("/api/chat/threads")).json()).threads;
  expect(after.some((t: any) => t.id === id)).toBeFalsy();
});

test("side chat messages are kept apart from Main, and a closed chat can't be written to", async ({ request }) => {
  const { thread } = await (await request.post("/api/chat/threads", { data: {} })).json();
  const side = await (await request.get(`/api/chat?thread=${thread.id}`)).json();
  expect(side.messages).toEqual([]);
  expect(side.threads.some((t: any) => t.id === thread.id)).toBeTruthy();

  const close = await request.delete(`/api/chat/threads?id=${thread.id}`);
  expect(close.ok()).toBeTruthy();
  expect((await request.delete(`/api/chat/threads?id=${thread.id}`)).status()).toBe(400);

  const res = await request.post("/api/chat", { multipart: { message: "x", thread_id: String(thread.id) } });
  expect(res.status()).toBe(400);
});
