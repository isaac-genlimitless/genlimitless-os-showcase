import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";

// Highlight-to-comment in the Files viewer. Works on a scratch copy of the resume page body
// (page 370 is only read, never modified or shared). Never presses Send or triggers an agent.

test.afterEach(() => cleanupFilesPages());

const TITLE = "E2E Resume and Cover Letter - Cresta (comments UI)";
const FALLBACK_BODY =
  "# Resume\n\nLed a distributed team shipping customer facing automation across several regions.\n\nSecond paragraph about measurable results and revenue growth.";

async function makeScratch(request: import("@playwright/test").APIRequestContext) {
  let body = FALLBACK_BODY;
  const src = await request.get("/api/files/370");
  if (src.ok()) {
    const j = await src.json();
    if (j?.page?.body) body = j.page.body;
  }
  const { page: p } = await (await request.post("/api/files", { data: { title: TITLE, body } })).json();
  return { id: p.id as number, body };
}

async function selectPhrase(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="page-editor"] .bn-editor') as HTMLElement;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = w.nextNode())) {
      const v = n.nodeValue || "";
      if (v.trim().length >= 30) {
        const start = v.search(/\S/) + 3;
        const end = start + 18;
        const r = document.createRange();
        r.setStart(n, start);
        r.setEnd(n, end);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
        (n.parentElement as HTMLElement).dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return v.slice(start, end);
      }
    }
    return "";
  });
}

const highlightCount = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (CSS as any).highlights.get("gl-comment")?.size ?? 0);

test("comment on selected text: save, reply, resolve, reopen, persist, body untouched", async ({ page, request }) => {
  const { id } = await makeScratch(request);
  const before = (await (await request.get(`/api/files/${id}`)).json()).page.body;

  let dialog = false;
  page.on("dialog", async (d) => {
    dialog = true;
    await d.dismiss();
  });

  await page.goto(`/files?id=${id}`);
  await expect(page.locator(".bn-editor")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("gl-comment-pill")).toBeVisible({ timeout: 20_000 });

  const phrase = await selectPhrase(page);
  expect(phrase.length).toBeGreaterThan(5);
  await expect(page.getByTestId("gl-comment-btn")).toBeVisible();
  await page.getByTestId("gl-comment-btn").click();

  const hostile = "<img src=x onerror=alert(1)>";
  await page.getByTestId("gl-comment-text").fill(hostile);
  await page.getByTestId("gl-comment-save").click();

  const thread = page.getByTestId("gl-thread").first();
  await expect(thread).toBeVisible();
  await expect(thread.getByTestId("gl-body")).toHaveText(hostile);
  await expect(thread.getByTestId("gl-author")).not.toHaveText("");
  await expect(thread.getByTestId("gl-time")).toContainText("CT");
  expect(await page.getByTestId("gl-comment-drawer").locator("img").count()).toBe(0);
  expect(await highlightCount(page)).toBe(1);

  await thread.getByTestId("gl-reply-text").fill("A reply");
  await thread.getByTestId("gl-reply-btn").click();
  await expect(page.getByTestId("gl-thread").first().getByTestId("gl-body").nth(1)).toHaveText("A reply");

  await page.getByTestId("gl-resolve-btn").click();
  await expect(page.getByTestId("gl-resolved-section")).toBeVisible();
  await expect.poll(() => highlightCount(page)).toBe(0);

  await page.getByTestId("gl-resolved-section").locator("summary").click();
  await page.getByTestId("gl-reopen-btn").click();
  await expect.poll(() => highlightCount(page)).toBe(1);

  await page.reload();
  await expect(page.getByTestId("gl-comment-pill")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("gl-comment-pill").click();
  await expect(page.getByTestId("gl-thread").first().getByTestId("gl-body").first()).toHaveText(hostile);
  await expect.poll(() => highlightCount(page)).toBe(1);

  const after = (await (await request.get(`/api/files/${id}`)).json()).page.body;
  expect(after).toBe(before);
  expect(dialog).toBe(false);
  expect(await page.locator('[data-testid="page-editor"] img[src="x"]').count()).toBe(0);
});

test("the Comments pill sits in the Files top bar, not floating over the chat", async ({ page, request }) => {
  const { id } = await makeScratch(request);
  await page.goto(`/files?id=${id}`);
  const pill = page.getByTestId("gl-comment-pill");
  await expect(pill).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("file-comments-slot").getByTestId("gl-comment-pill")).toBeVisible();
  expect(await pill.evaluate((el) => getComputedStyle(el).position)).not.toBe("fixed");
  const box = await pill.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeLessThan(120);
  await pill.click();
  await expect(page.getByTestId("gl-comment-drawer")).toBeVisible();
});

test("the highlight re-anchors after text around the quote is edited", async ({ page, request }) => {
  const { id } = await makeScratch(request);

  await page.goto(`/files?id=${id}`);
  await expect(page.getByTestId("gl-comment-pill")).toBeVisible({ timeout: 20_000 });
  await selectPhrase(page);
  await page.getByTestId("gl-comment-btn").click();
  await page.getByTestId("gl-comment-text").fill("anchor check");
  await page.getByTestId("gl-comment-save").click();
  await expect(page.getByTestId("gl-thread")).toHaveCount(1);
  expect(await highlightCount(page)).toBe(1);

  const cur = (await (await request.get(`/api/files/${id}`)).json()).page.body as string;
  const res = await request.patch(`/api/files/${id}`, { data: { body: `Intro line added above.\n\n${cur}\n\nOutro line added below.` } });
  expect(res.ok()).toBeTruthy();

  await page.reload();
  await expect(page.getByTestId("gl-comment-pill")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => highlightCount(page)).toBe(1);
});
