import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";
import { openTestDb } from "./db-handle";
import { normalise } from "../src/lib/chief-mentions";

// Instant blue "pending" @Chief styling. Never presses Send or starts an agent; rows are only seeded.

test.afterEach(() => cleanupFilesPages());

const unique = (label: string) => `E2E Chief pending ${label} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function withDb<T>(fn: (db: ReturnType<typeof openTestDb>) => T): T {
  const db = openTestDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function makePage(request: any, body: string) {
  const { page } = await (await request.post("/api/files", { data: { title: unique("page"), body } })).json();
  return page as { id: number };
}

const colorOf = (loc: any) => loc.evaluate((el: Element) => getComputedStyle(el).color);
const varColor = (page: any, name: string) =>
  page.evaluate((n: string) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${n})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);

test("typed @Chief turns bold + blue instantly; look-alikes do not", async ({ page, request }) => {
  const p = await makePage(request, "First line");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/files?id=${p.id}`);
  const editor = page.locator(".bn-editor");
  await expect(editor.getByText("First line")).toBeVisible({ timeout: 20_000 });
  await editor.getByText("First line").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Call mom @Chief");

  const pending = page.locator(".chief-mention-pending");
  await expect(pending).toHaveCount(1);
  expect(Number(await pending.evaluate((el) => getComputedStyle(el).fontWeight))).toBeGreaterThanOrEqual(700);
  expect(await colorOf(pending)).toBe(await varColor(page, "--blue"));
  await expect(pending).not.toHaveClass(/chief-mention-active/);

  await page.keyboard.type("r");
  await expect(pending).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await expect(pending).toHaveCount(1);

  await page.keyboard.press("Enter");
  await page.keyboard.type("mail chief@x.com");
  await expect(pending).toHaveCount(1);
});

test("done is gold, waiting is blue with its card, baseline is unstyled", async ({ page, request }) => {
  const mk = (id: string, text: string) => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });
  const p = await makePage(request, "x");
  const res = await request.patch(`/api/files/${p.id}`, {
    data: { content: [mk("pm-1", "Alpha task @Chief"), mk("pm-2", "Beta task @Chief"), mk("pm-3", "Gamma task @Chief")] },
  });
  expect(res.ok()).toBeTruthy();
  const { blocks } = await (await request.get(`/api/files/${p.id}`)).json();
  const idOf = (needle: string) => blocks.find((b: any) => JSON.stringify(b.content).includes(needle)).id as string;
  withDb((db) => {
    const ins = db.prepare(
      `INSERT INTO page_mentions (page_id, mention_key, norm_text, mention_text, block_id, page_title, status, result_text)
       VALUES (?, ?, ?, ?, ?, 'T', ?, ?)`
    );
    const mk2 = (key: string, text: string, needle: string, status: string, summary: string | null) =>
      ins.run(p.id, key, normalise(text), text, idOf(needle), status, summary);
    mk2("pd-1", "Alpha task @Chief", "Alpha", "done", "ok");
    mk2("pd-2", "Beta task @Chief", "Beta", "waiting", null);
    mk2("pd-3", "Gamma task @Chief", "Gamma", "baseline", null);
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/files?id=${p.id}`);
  const editor = page.locator(".bn-editor");
  await expect(editor.getByText("Alpha task")).toBeVisible({ timeout: 20_000 });

  const gold = page.locator(".chief-mention-active");
  await expect(gold).toHaveCount(1);
  expect(await colorOf(gold)).toBe(await varColor(page, "--accent"));

  const blue = page.locator(".chief-mention-pending");
  await expect(blue).toHaveCount(1);
  expect(await colorOf(blue)).toBe(await varColor(page, "--blue"));
  await blue.hover();
  await expect(page.getByTestId("chief-mention-box").filter({ hasText: "10 min" })).toBeVisible();

  // The baseline line (Gamma) has no styling at all.
  const gamma = editor.getByText("Gamma task");
  await expect(gamma.locator(".chief-mention-pending, .chief-mention-active")).toHaveCount(0);
});
