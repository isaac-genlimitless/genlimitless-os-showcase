import zlib from "zlib";
import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";

// Files "Download" menu (Word / PDF print view / Markdown). Read-only: creates its own pages via
// the API with unique titles. Never presses Send or triggers an agent.

test.afterEach(() => cleanupFilesPages());

const unique = (label: string) => `E2E ${label} ${Date.now()}`;

/** Tiny unzip: walk local file headers and inflate each entry. */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let o = 0;
  while (o + 30 <= buf.length && buf.readUInt32LE(o) === 0x04034b50) {
    const method = buf.readUInt16LE(o + 8);
    const csize = buf.readUInt32LE(o + 18);
    const nlen = buf.readUInt16LE(o + 26);
    const elen = buf.readUInt16LE(o + 28);
    const name = buf.subarray(o + 30, o + 30 + nlen).toString();
    const data = buf.subarray(o + 30 + nlen + elen, o + 30 + nlen + elen + csize);
    out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
    o += 30 + nlen + elen + csize;
  }
  return out;
}

const BODY = "# Summary\n\n**Bold** skill\n\n- bullet one\n\n[site](https://example.com)";

async function makePage(request: import("@playwright/test").APIRequestContext, title: string, body = BODY) {
  const { page } = await (await request.post("/api/files", { data: { title, body } })).json();
  return page as { id: number; title: string };
}

test("export as Markdown: title first, body intact, sanitized filename", async ({ request }) => {
  const stamp = Date.now();
  const title = `E2E Resume: A/B ${stamp}`;
  const p = await makePage(request, title);
  const res = await request.get(`/api/files/${p.id}/export?format=md`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toContain(encodeURIComponent(`E2E Resume- A-B ${stamp}.md`));
  const text = await res.text();
  expect(text.startsWith(`# ${title}`)).toBe(true);
  expect(text).toContain("Summary");
  expect(text).toContain("bullet one");
});

test("export as Word: a real docx with headings, bold, bullets and links", async ({ request }) => {
  const title = unique("Docx");
  const p = await makePage(request, title);
  const res = await request.get(`/api/files/${p.id}/export?format=docx`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("wordprocessingml");
  const buf = await res.body();
  expect(buf.subarray(0, 2).toString()).toBe("PK");
  const files = unzip(buf);
  const doc = files["word/document.xml"];
  expect(doc).toContain("Summary");
  expect(doc).toContain("<w:b/>");
  expect(doc).toContain("bullet one");
  expect(doc).toContain("Heading1");
  expect(doc).toContain(title);
  expect(files["word/_rels/document.xml.rels"]).toContain("https://example.com");
  const noTitle = unzip(await (await request.get(`/api/files/${p.id}/export?format=docx&title=0`)).body());
  expect(noTitle["word/document.xml"]).not.toContain(title);

  const withTitle = unzip(await (await request.get(`/api/files/${p.id}/export?format=docx&title=1`)).body());
  expect(withTitle["word/document.xml"]).toContain(title);
});

test("export as PDF: a real .pdf attachment, no print script, no header/footer text", async ({ request }) => {
  const title = unique("Pdf");
  const p = await makePage(request, title, `${BODY}\n\n<script>alert(1)</script>`);
  const res = await request.get(`/api/files/${p.id}/export?format=pdf`);
  expect(res.status()).toBe(200);
  expect(["chromium", "builtin"]).toContain(res.headers()["x-pdf-engine"]);
  expect(res.headers()["content-type"]).toContain("application/pdf");
  const disp = res.headers()["content-disposition"];
  expect(disp).toContain("attachment");
  expect(disp).toContain(".pdf");
  const buf = await res.body();
  expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  const raw = buf.toString("latin1");
  expect(raw).not.toContain("window.print");
  // Header/footer are off, so the browser's localhost URL never appears in the file.
  expect(raw).not.toContain("localhost");
  expect(raw).toMatch(/\/Type\s*\/Page\b/);

  const withTitle = await request.get(`/api/files/${p.id}/export?format=pdf&title=1`);
  expect(withTitle.status()).toBe(200);
  expect((await withTitle.body()).subarray(0, 5).toString()).toBe("%PDF-");
});

test("downloads start with the page title, like the resume on Files 425", async ({ request }) => {
  const title = unique("Resume");
  const p = await makePage(request, title, "# Owner\n\n**Customer Experience Operations Manager**\n\nbody text");
  const md = await (await request.get(`/api/files/${p.id}/export?format=md`)).text();
  expect(md.startsWith(`# ${title}\n\n# Owner`)).toBe(true);
  const doc = unzip(await (await request.get(`/api/files/${p.id}/export?format=docx`)).body())["word/document.xml"];
  expect(doc).toContain(title);
  expect(doc.indexOf(title)).toBeLessThan(doc.indexOf("Owner"));
  expect(doc).toContain("Title");
  const pdf = await request.get(`/api/files/${p.id}/export?format=pdf`);
  expect(pdf.status()).toBe(200);
  const pdfBuf = await pdf.body();
  expect(pdfBuf.subarray(0, 5).toString()).toBe("%PDF-");
  const bare = await (await request.get(`/api/files/${p.id}/export?format=pdf&title=0`)).body();
  expect(pdfBuf.length).toBeGreaterThan(bare.length);
});

test("no duplicate title", async ({ request }) => {
  const title = unique("Dup");
  const p = await makePage(request, title, `# ${title}\n\nbody`);
  const md = await (await request.get(`/api/files/${p.id}/export?format=md`)).text();
  expect(md.split(title).length).toBe(2);
  const doc = unzip(await (await request.get(`/api/files/${p.id}/export?format=docx`)).body())["word/document.xml"];
  expect(doc.split(title).length).toBe(2);
});

test("export errors: unknown page, unknown format, folder", async ({ request }) => {
  const p = await makePage(request, unique("Err"));
  expect((await request.get("/api/files/999999999/export?format=md")).status()).toBe(404);
  expect((await request.get(`/api/files/${p.id}/export?format=xyz`)).status()).toBe(400);
  const { page: folder } = await (await request.post("/api/files", { data: { title: unique("ErrFolder"), kind: "folder" } })).json();
  expect((await request.get(`/api/files/${folder.id}/export?format=md`)).status()).toBe(400);
});

test("exporting never changes the page", async ({ request }) => {
  const p = await makePage(request, unique("ReadOnly"));
  const before = await (await request.get(`/api/files/${p.id}`)).json();
  for (const f of ["md", "docx", "pdf"]) await request.get(`/api/files/${p.id}/export?format=${f}&title=1`);
  const after = await (await request.get(`/api/files/${p.id}`)).json();
  expect(after).toEqual(before);
});

test("Download menu on a page downloads a .docx; folders have no menu", async ({ page, request }) => {
  const title = unique("UiDownload");
  const p = await makePage(request, title);
  await page.goto(`/files?id=${p.id}`);
  await expect(page.getByLabel("Title")).toHaveValue(title, { timeout: 20_000 });
  await page.getByTestId("download-menu").click();
  await expect(page.getByRole("menuitem", { name: /Word/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /PDF/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Markdown/ })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /Word/ }).click()]);
  expect(download.suggestedFilename()).toBe(`${title}.docx`);

  // PDF: always a direct download, no popup tab.
  let popup = false;
  page.on("popup", () => (popup = true));
  await page.getByTestId("download-menu").click();
  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /PDF/ }).click()]);
  expect(pdf.suggestedFilename()).toBe(`${title}.pdf`);
  expect(popup).toBe(false);

  const { page: folder } = await (await request.post("/api/files", { data: { title: unique("UiFolder"), kind: "folder" } })).json();
  await page.goto(`/files?id=${folder.id}`);
  await expect(page.getByLabel("Title")).toHaveValue(folder.title, { timeout: 20_000 });
  await expect(page.getByTestId("download-menu")).toHaveCount(0);
});
