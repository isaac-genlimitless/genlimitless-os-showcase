import { test, expect, type Page } from "@playwright/test";

// Never presses Send / never triggers an agent.

async function dropFiles(page: Page, files: { name: string; type: string; content: string }[]) {
  const root = page.getByTestId("chat-panel-root").first();
  await root.evaluate((el, fs) => {
    const dt = new DataTransfer();
    for (const f of fs) dt.items.add(new File([f.content], f.name, { type: f.type }));
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
}

async function dragEnter(page: Page) {
  const root = page.getByTestId("chat-panel-root").first();
  await root.evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "a.txt", { type: "text/plain" }));
    el.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
}

async function checkPanel(page: Page) {
  await dragEnter(page);
  await expect(page.getByTestId("chat-dropzone")).toBeVisible();
  await dropFiles(page, [
    { name: "notes.txt", type: "text/plain", content: "hello" },
    { name: "pic.png", type: "image/png", content: "png" },
  ]);
  await expect(page.getByTestId("chat-dropzone")).toHaveCount(0);
  await expect(page.getByTestId("chat-file-chip")).toHaveCount(2);
  await page.getByTestId("chat-file-chip").first().getByRole("button").click();
  await expect(page.getByTestId("chat-file-chip")).toHaveCount(1);

  await dropFiles(page, [{ name: "evil.exe", type: "application/octet-stream", content: "MZ" }]);
  await expect(page.getByTestId("chat-file-error")).toContainText("isn't a supported file type");
  await expect(page.getByTestId("chat-file-chip")).toHaveCount(1);
}

test("main chat: drop zone, chips, and rejected type", async ({ page }) => {
  await page.goto("/");
  await checkPanel(page);
});

test("dock chat on /files: drop zone and rejected type", async ({ page }) => {
  await page.goto("/files");
  const attach = page.getByTestId("attach-btn");
  if (!(await attach.first().isVisible().catch(() => false))) {
    // Open via the button (rendered once the dock is ready), not a key toggle.
    await page.getByTestId("chat-dock-open").click();
  }
  await expect(attach.first()).toBeVisible();
  await checkPanel(page);
});

test("API rejects an unsupported type before saving", async ({ request }) => {
  const before = await (await request.get("/api/chat")).json();
  const res = await request.post("/api/chat", {
    multipart: { message: "hi", files: { name: "x.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") } },
  });
  expect(res.status()).toBe(400);
  const after = await (await request.get("/api/chat")).json();
  expect(after.messages.length).toBe(before.messages.length);
});

test("API rejects an over-limit file", async ({ request }) => {
  const res = await request.post("/api/chat", {
    multipart: { message: "hi", files: { name: "big.txt", mimeType: "text/plain", buffer: Buffer.alloc(26 * 1024 * 1024, "a") } },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain("25 MB");
});
