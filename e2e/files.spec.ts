import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";

// Files (the Notion-style workspace that replaced Docs). Creates its own pages via the API with
// unique titles and only ever moves them to the Trash / deletes them from it. Never presses Send
// or triggers the agent; the isolated server runs with DISABLE_AUTO_ORGANIZE so no AI filing runs.

test.afterEach(() => cleanupFilesPages());

const unique = (label: string) => `E2E ${label} ${Date.now()}`;

test("a page opens in the block editor, edits autosave, and survive a reload", async ({ page, request }) => {
  const title = unique("Page");
  const { page: p } = await (await request.post("/api/files", { data: { title, body: "# Hello Files\n\nOriginal content." } })).json();

  await page.goto(`/files?id=${p.id}`);
  await expect(page.getByLabel("Title")).toHaveValue(title, { timeout: 20_000 });
  const editor = page.locator(".bn-editor");
  await expect(editor.getByText("Original content.")).toBeVisible({ timeout: 20_000 });

  await editor.getByText("Original content.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Edited in the editor.");
  await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });

  // Saved as blocks for the editor and as markdown for search and the agents.
  const saved = await (await request.get(`/api/files/${p.id}`)).json();
  expect(saved.page.body).toContain("Original content. Edited in the editor.");

  await page.reload();
  await expect(page.locator(".bn-editor").getByText("Original content. Edited in the editor.")).toBeVisible({ timeout: 20_000 });
});

test("old /docs links redirect to the same page in Files", async ({ page, request }) => {
  const title = unique("Redirect");
  const { doc } = await (await request.post("/api/docs", { data: { title, body: "Legacy doc." } })).json();
  await page.goto(`/docs?id=${doc.id}`);
  await expect(page).toHaveURL(new RegExp(`/files\\?id=${doc.id}$`));
  await expect(page.getByLabel("Title")).toHaveValue(title, { timeout: 20_000 });
});

test("folders nest pages; the tree and breadcrumb show where a page lives", async ({ page, request }) => {
  const folder = unique("Folder");
  const title = unique("Nested");
  const { page: p } = await (await request.post("/api/files", { data: { title, body: "Inside.", folder_path: `${folder}/Sub` } })).json();
  const view = await (await request.get(`/api/files/${p.id}`)).json();
  expect(view.breadcrumb.map((b: { title: string }) => b.title)).toEqual([folder, "Sub"]);

  await page.goto(`/files?id=${p.id}`);
  await expect(page.getByLabel("Title")).toHaveValue(title, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: folder, exact: true })).toBeVisible(); // breadcrumb
  await expect(page.getByTestId(`tree-item-${p.id}`)).toBeVisible(); // tree expanded to it

  // A folder can't be moved inside its own sub-folder.
  const parentId = view.breadcrumb[0].id;
  const bad = await request.patch(`/api/files/${parentId}`, { data: { parent_id: view.breadcrumb[1].id } });
  expect(bad.status()).toBe(400);
});

test("search finds pages by content and shows a snippet", async ({ page, request }) => {
  const word = `zebracorn${Date.now()}`;
  const title = unique("Searchable");
  await request.post("/api/files", { data: { title, body: `Notes mentioning ${word} in the middle.` } });

  const api = await (await request.get(`/api/files?q=${word}`)).json();
  expect(api.hits[0].title).toBe(title);

  await page.goto("/files");
  await page.getByPlaceholder("Search everything…").fill(word);
  const hit = page.getByTestId("search-hit").filter({ hasText: title });
  await expect(hit).toBeVisible({ timeout: 10_000 });
  await hit.click();
  await expect(page.getByLabel("Title")).toHaveValue(title, { timeout: 20_000 });
});

test("search input can't inject FTS syntax", async ({ request }) => {
  const res = await request.get(`/api/files?q=${encodeURIComponent('") OR title:* NEAR( "')}`);
  expect(res.ok()).toBeTruthy();
});

test("Trash is a soft delete: a folder goes with its contents and comes back on restore", async ({ page, request }) => {
  const folderTitle = unique("TrashFolder");
  const { page: folder } = await (await request.post("/api/files", { data: { title: folderTitle, kind: "folder" } })).json();
  const { page: child } = await (await request.post("/api/files", { data: { title: unique("TrashChild"), parent_id: folder.id, body: "x" } })).json();

  page.once("dialog", (d) => d.accept());
  await page.goto(`/files?id=${folder.id}`);
  await expect(page.getByLabel("Title")).toHaveValue(folderTitle, { timeout: 20_000 });
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await expect(page).toHaveURL(/\/files$/);

  const trash = (await (await request.get("/api/files?trash=1")).json()).trash;
  const entry = trash.find((t: { id: number }) => t.id === folder.id);
  expect(entry.inside).toBe(1);
  expect(trash.some((t: { id: number }) => t.id === child.id)).toBeFalsy(); // listed under its folder, not separately

  // Still there, just archived.
  expect((await (await request.get(`/api/files/${child.id}`)).json()).page.status).toBe("archived");

  await page.goto("/files?view=trash");
  const row = page.locator("div", { hasText: folderTitle }).filter({ has: page.getByRole("button", { name: "Restore" }) }).last();
  await row.getByRole("button", { name: "Restore" }).click();
  await expect.poll(async () => (await (await request.get(`/api/files/${child.id}`)).json()).page.status).toBe("active");
});

test("permanent delete only works on items already in the Trash", async ({ request }) => {
  const { page: p } = await (await request.post("/api/files", { data: { title: unique("Forever"), body: "bye" } })).json();
  const refused = await request.delete(`/api/files/${p.id}?forever=1`);
  expect(refused.status()).toBe(400);
  expect((await request.get(`/api/files/${p.id}`)).ok()).toBeTruthy();

  await request.delete(`/api/files/${p.id}`);
  const gone = await request.delete(`/api/files/${p.id}?forever=1`);
  expect((await gone.json()).deleted).toBe(1);
  expect((await request.get(`/api/files/${p.id}`)).status()).toBe(404);
});

test("uploaded text files are searchable, and HTML uploads are never served as a page", async ({ request }) => {
  const word = `uploadword${Date.now()}`;
  const up = await request.post("/api/files", {
    multipart: {
      files: { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(`hello ${word}`) },
    },
  });
  const { pages } = await up.json();
  expect(pages[0].kind).toBe("file");
  expect((await (await request.get(`/api/files?q=${word}`)).json()).hits[0].id).toBe(pages[0].id);

  const html = await request.post("/api/files", {
    multipart: { files: { name: "evil.html", mimeType: "text/html", buffer: Buffer.from("<script>alert(1)</script>") } },
  });
  const evil = (await html.json()).pages[0];
  const raw = await request.get(`/api/files/${evil.id}/raw`);
  expect(raw.headers()["content-type"]).toBe("application/octet-stream");
  expect(raw.headers()["content-disposition"]).toContain("attachment");
  expect(raw.headers()["content-security-policy"]).toBe("sandbox");
});

// Regression: /api/uploads/<file> read from ./data/uploads while uploads were written to
// GENLIMITLESS_DATA_DIR, so images added to a page 404'd on any server with its own data dir.
test("images added to a page in the editor can be loaded back", async ({ request }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const res = await request.post("/api/uploads", { multipart: { file: { name: "dot.png", mimeType: "image/png", buffer: png } } });
  expect(res.status()).toBe(201);
  const { url } = await res.json();
  const img = await request.get(url);
  expect(img.ok()).toBeTruthy();
  expect(img.headers()["content-type"]).toBe("image/png");
});

test("markdown from an agent renders safely: a script tag in a page body does not execute", async ({ page, request }) => {
  const title = unique("XSS");
  const { page: p } = await (await request.post("/api/files", { data: { title, body: "<script>window.__filesXssRan = true;</script>\n\n# Safe Heading" } })).json();
  await page.goto(`/files?id=${p.id}`);
  await expect(page.locator(".bn-editor").getByText("Safe Heading")).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => (window as unknown as { __filesXssRan?: boolean }).__filesXssRan)).toBeUndefined();
});
