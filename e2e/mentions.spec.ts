import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";
import { openTestDb } from "./db-handle";
import { allTools } from "../src/lib/agents/tools";
import { buildMentionContext, extractMentionRefs, isMentionHref, parseMentionHref } from "../src/lib/mentions";
import { buildEditorMentionRows } from "../src/lib/mention-items";
import { processMentions, type MentionJob } from "../src/lib/chief-mentions";

// "@" mentions: the picker in the Files editor and in chat, clickable chips, and the context that
// reaches Chief. Nothing here presses Send or starts an agent: chat tests block and count POST
// /api/chat (must stay 0), and the @Chief pass is driven in-process with a STUB runner.

type Db = ReturnType<typeof openTestDb>;
function withDb<T>(fn: (db: Db) => T): T {
  const db = openTestDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const seeded = { tasks: [] as number[], meetings: [] as number[], chats: [] as number[] };

test.afterEach(() => {
  if (!process.env.E2E_START_SERVER) return;
  cleanupFilesPages();
  withDb((db) => {
    // Only the exact rows this spec created.
    for (const id of seeded.tasks.splice(0)) db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
    for (const id of seeded.meetings.splice(0)) db.prepare(`DELETE FROM meetings WHERE id = ?`).run(id);
    for (const id of seeded.chats.splice(0)) db.prepare(`DELETE FROM chat_history WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM page_mentions WHERE page_title LIKE 'E2E %'`).run();
  });
});

// Pretend @Chief went live long ago so the pages made here are not "baseline".
test.beforeEach(() => {
  if (!process.env.E2E_START_SERVER) return;
  withDb((db) =>
    db
      .prepare(
        `INSERT INTO job_runs (job, run_key, status, created_at) VALUES ('chief_mentions_golive','v1','done','2000-01-01 00:00:00')
         ON CONFLICT(job, run_key) DO UPDATE SET created_at='2000-01-01 00:00:00'`
      )
      .run()
  );
});

const token = (label: string) => `Mntn${label}${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function seedTask(request: any, title: string, extra: { notes?: string; updated?: string } = {}) {
  const res = await request.post("/api/tasks", { data: { title, notes: extra.notes ?? null } });
  expect(res.ok()).toBeTruthy();
  const id = (await res.json()).task.id as number;
  seeded.tasks.push(id);
  if (extra.updated) withDb((db) => db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(extra.updated, id));
  return id;
}

async function seedMeeting(request: any, title: string, notes = "", started = "") {
  await request.get("/api/meetings"); // makes sure the table exists in the isolated DB
  const id = withDb(
    (db) =>
      db
        .prepare(`INSERT INTO meetings (title, status, notes, started_at) VALUES (?, 'ready', ?, COALESCE(NULLIF(?, ''), datetime('now')))`)
        .run(title, notes, started).lastInsertRowid as number
  );
  seeded.meetings.push(Number(id));
  return Number(id);
}

async function seedPage(request: any, title: string, body = "Hello there") {
  const { page } = await (await request.post("/api/files", { data: { title, body } })).json();
  return page as { id: number };
}

// ---------------------------------------------------------------- 1. API

test("/api/mentions lists recent items newest first, filters by q, and treats % and _ literally", async ({ request }) => {
  const t = token("A");
  const taskId = await seedTask(request, `E2E ${t} task`, { updated: "2099-01-03 00:00:00" });
  const meetingId = await seedMeeting(request, `E2E ${t} meeting`, "", "2099-01-02 00:00:00");
  const pg = await seedPage(request, `E2E ${t} page`);
  withDb((db) => db.prepare(`UPDATE docs SET updated_at = '2099-01-01 00:00:00' WHERE id = ?`).run(pg.id));

  const all = (await (await request.get("/api/mentions")).json()).items as any[];
  expect(all.slice(0, 3).map((i) => `${i.type}:${i.id}`)).toEqual([`task:${taskId}`, `meeting:${meetingId}`, `page:${pg.id}`]);
  expect(all[0].url).toBe(`/tasks?id=${taskId}`);
  expect(all[1].url).toBe(`/meetings?id=${meetingId}`);
  expect(all[2].url).toBe(`/files?id=${pg.id}`);

  const filtered = (await (await request.get(`/api/mentions?q=${encodeURIComponent(t.toLowerCase())}`)).json()).items as any[];
  expect(filtered.map((i) => i.type).sort()).toEqual(["meeting", "page", "task"]);

  // % and _ are literal characters, not wildcards.
  const lit = token("B");
  const pct = await seedTask(request, `E2E ${lit}100% done`);
  await seedTask(request, `E2E ${lit}100X done`);
  const byPct = (await (await request.get(`/api/mentions?q=${encodeURIComponent(`${lit}100%`)}`)).json()).items as any[];
  expect(byPct.map((i) => i.id)).toEqual([pct]);
  const byUnderscore = (await (await request.get(`/api/mentions?q=${encodeURIComponent(`${lit}_`)}`)).json()).items as any[];
  expect(byUnderscore).toHaveLength(0);
});

// ---------------------------------------------------------------- 2. editor picker

async function openEditor(page: any, id: number) {
  await page.goto(`/files?id=${id}`);
  await expect(page.locator(".bn-editor").getByText("Hello there")).toBeVisible({ timeout: 20_000 });
  await page.locator(".bn-editor").getByText("Hello there").click();
  await page.keyboard.press("End");
}

test("editor: @ opens the picker (Chief first), filtering and Enter insert a task chip that is saved", async ({ page, request }) => {
  const t = token("C");
  const taskId = await seedTask(request, `E2E ${t} task`);
  const pg = await seedPage(request, `E2E ${t} editor`);
  await openEditor(page, pg.id);

  await page.keyboard.type(" @");
  const menu = page.locator(".bn-suggestion-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu.locator(".bn-suggestion-menu-item").first()).toContainText("Chief");

  await page.keyboard.type(t);
  await expect(menu.locator(".bn-suggestion-menu-item")).toHaveCount(1, { timeout: 10_000 });
  await page.keyboard.press("Enter");

  const chip = page.locator(`.bn-editor a[href="/tasks?id=${taskId}"]`);
  await expect(chip).toHaveText(`@E2E ${t} task`);
  await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });
  const saved = await (await request.get(`/api/files/${pg.id}`)).json();
  expect(saved.page.body).toContain(`](/tasks?id=${taskId})`);
});

test("editor: @ inside an email address does not open the picker; Escape closes it without inserting", async ({ page, request }) => {
  const pg = await seedPage(request, `E2E ${token("D")} editor`);
  await openEditor(page, pg.id);

  await page.keyboard.type(" mail chief@x.com");
  await expect(page.locator(".bn-suggestion-menu")).toHaveCount(0);

  await page.keyboard.type(" @");
  await expect(page.locator(".bn-suggestion-menu")).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(page.locator(".bn-suggestion-menu")).toHaveCount(0);
  await expect(page.locator(".bn-editor a")).toHaveCount(0);
});

test("editor: choosing Chief inserts plain @Chief text", async ({ page, request }) => {
  const pg = await seedPage(request, `E2E ${token("E")} editor`);
  await openEditor(page, pg.id);
  await page.keyboard.type(" @Je");
  await expect(page.locator(".bn-suggestion-menu .bn-suggestion-menu-item").first()).toContainText("Chief", { timeout: 10_000 });
  await page.keyboard.press("Enter");
  await expect(page.locator(".bn-editor")).toContainText("@Chief");
  await expect(page.locator(".bn-editor a")).toHaveCount(0);
});

test("editor: mixed page+task results show contiguous groups, unique titles and fallbacks", async ({ page, request }) => {
  const pg = await seedPage(request, `E2E ${token("M")} editor`);
  const mixed = [
    { type: "task", id: 9001, title: "Alpha", url: "/tasks?id=9001", updated_at: "2026-01-01" },
    { type: "page", id: 9002, title: "Alpha", url: "/files?id=9002", updated_at: "2026-01-02" },
    { type: "task", id: 9003, title: "", url: "/tasks?id=9003", updated_at: "2026-01-03" },
    { type: "page", id: 9004, title: "Beta", url: "/files?id=9004", updated_at: "2026-01-04" },
    { type: "meeting", id: 9005, title: "Gamma", url: "/meetings?id=9005", updated_at: "2026-01-05" },
    { type: "task", id: 9006, title: "Beta", url: "/tasks?id=9006", updated_at: "2026-01-06" },
    { type: "page", id: 9007, title: null, url: "/files?id=9007", updated_at: "2026-01-07" },
    { type: "page", id: 9008, title: "Page", url: "/files?id=9008", updated_at: "2026-01-08" },
  ];
  await page.route("**/api/mentions*", (route: any) => route.fulfill({ json: { items: mixed } }));
  const posts = await blockChatPosts(page);
  await openEditor(page, pg.id);

  await page.keyboard.type(" @");
  const menu = page.locator(".bn-suggestion-menu");
  const items = menu.locator(".bn-suggestion-menu-item");
  await expect(items).toHaveCount(9, { timeout: 10_000 }); // Chief + 8
  await expect(menu.locator(".bn-suggestion-menu-label")).toHaveText(["Assistant", "Pages", "Meetings", "Tasks"]);
  const texts = (await items.allInnerTexts()).map((s) => s.trim());
  for (const s of texts) expect(s.length).toBeGreaterThan(0);
  await expect(items.locator("span.text-base")).toHaveCount(9);
  const titles = await items.locator(".bn-mt-suggestion-menu-item-title").allInnerTexts();
  expect(new Set(titles.map((s) => s.trim().toLowerCase())).size).toBe(titles.length);
  expect(titles).toContain("Untitled task");
  expect(titles).toContain("Untitled page");
  expect(titles.filter((s) => s.trim() === "Alpha")).toHaveLength(1);
  expect(titles.filter((s) => /^Alpha \(#\d+\)$/.test(s.trim()))).toHaveLength(1);

  await page.keyboard.type("cam");
  await expect(items).toHaveCount(8, { timeout: 10_000 }); // Chief gone

  await menu.locator(".bn-suggestion-menu-item", { hasText: "Untitled task" }).click();
  const chip = page.locator('.bn-editor a[href="/tasks?id=9003"]');
  await expect(chip).toHaveText("@Untitled task");
  expect(posts.count).toBe(0);
});

test("buildEditorMentionRows groups contiguously and makes titles unique", () => {
  const rows = buildEditorMentionRows([
    { type: "task", id: 1, title: "A", url: "/tasks?id=1" },
    { type: "page", id: 2, title: "A", url: "/files?id=2" },
    { type: "task", id: 3, title: null, url: "/tasks?id=3" },
    { type: "page", id: 4, title: "Page", url: "/files?id=4" },
    { type: "task", id: 5, title: "x", url: "" },
  ]);
  expect(rows.map((r) => r.group)).toEqual(["Pages", "Pages", "Tasks", "Tasks"]);
  expect(new Set(rows.map((r) => r.title.toLowerCase())).size).toBe(rows.length);
  expect(rows.map((r) => r.title)).toEqual(["A", "Page (#4)", "A (#1)", "Untitled task"]);
});

test("chat picker shows Untitled task for an empty title, not a bare @", async ({ page }) => {
  const posts = await blockChatPosts(page);
  await page.route("**/api/mentions*", (route: any) =>
    route.fulfill({ json: { items: [{ type: "task", id: 9003, title: "", url: "/tasks?id=9003", updated_at: "2026-01-03" }] } })
  );
  await page.goto("/");
  const box = page.getByPlaceholder(/Message Chief/);
  await box.click();
  await box.pressSequentially("@zz");
  const opt = page.getByTestId("mention-picker").getByTestId("mention-option");
  await expect(opt).toHaveCount(1, { timeout: 10_000 });
  await expect(opt.first().locator("div").first()).toHaveText("@Untitled task");
  expect(posts.count).toBe(0);
});

// ---------------------------------------------------------------- 3. chips navigate

test("clicking chips in the editor opens the task, the meeting and the page", async ({ page, request }) => {
  const t = token("F");
  const taskId = await seedTask(request, `E2E ${t} task`);
  const meetingId = await seedMeeting(request, `E2E ${t} meeting`);
  const target = await seedPage(request, `E2E ${t} target`);
  const host = await seedPage(
    request,
    `E2E ${t} host`,
    `[@task](/tasks?id=${taskId})\n\n[@meeting](/meetings?id=${meetingId})\n\n[@page](/files?id=${target.id})`
  );

  await page.goto(`/files?id=${host.id}`);
  await page.locator(`.bn-editor a[href="/tasks?id=${taskId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/tasks\\?id=${taskId}$`), { timeout: 15_000 });
  await expect(page.locator(`[data-task-id="${taskId}"]`)).toHaveAttribute("data-highlighted", "true");

  await page.goto(`/files?id=${host.id}`);
  await page.locator(`.bn-editor a[href="/meetings?id=${meetingId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/meetings\\?id=${meetingId}$`), { timeout: 15_000 });

  await page.goto(`/files?id=${host.id}`);
  await page.locator(`.bn-editor a[href="/files?id=${target.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/files\\?id=${target.id}$`), { timeout: 15_000 });
});

// ---------------------------------------------------------------- 4. chat picker

async function blockChatPosts(page: any) {
  const posts = { count: 0 };
  await page.route("**/api/chat", async (route: any) => {
    if (route.request().method() !== "POST") return route.continue();
    posts.count++;
    await route.abort();
  });
  return posts;
}

async function checkChatPicker(page: any, box: any, request: any, posts: { count: number }) {
  const t = token("G");
  const taskId = await seedTask(request, `E2E ${t} task`);
  await box.click();
  await box.pressSequentially("@");
  const picker = page.getByTestId("mention-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId("mention-option").first()).toContainText("Chief");

  await box.pressSequentially(t);
  await expect(picker.getByTestId("mention-option")).toHaveCount(1, { timeout: 10_000 });
  await box.press("ArrowDown");
  await box.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(box).toHaveValue(`@E2E ${t} task `);

  // Escape closes without inserting anything.
  await box.fill("");
  await box.pressSequentially("hi @");
  await expect(picker).toBeVisible();
  await box.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(box).toHaveValue("hi @");

  // An email address never opens it.
  await box.fill("");
  await box.pressSequentially("mail chief@x.com");
  await expect(picker).toHaveCount(0);

  expect(posts.count).toBe(0); // Enter with the picker open never sent
  expect(taskId).toBeGreaterThan(0);
}

test("chat picker on the main chat", async ({ page, request }) => {
  const posts = await blockChatPosts(page);
  await page.goto("/");
  await checkChatPicker(page, page.getByPlaceholder(/Message Chief/), request, posts);
});

test("chat picker in the dock on another page", async ({ page, request }) => {
  const posts = await blockChatPosts(page);
  await page.goto("/tasks");
  const box = page.getByPlaceholder(/Ask about this page/);
  if (!(await box.isVisible().catch(() => false))) await page.keyboard.press("Control+j");
  await expect(box).toBeVisible();
  await checkChatPicker(page, box, request, posts);
});

test("chat picker in a side chat", async ({ page, request }) => {
  const posts = await blockChatPosts(page);
  await page.goto("/");
  await expect(page.getByTestId("chat-tab-main")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "+ New chat" }).click();
  await expect(page.getByText(/Side chat\. Ask for anything while Main keeps working/)).toBeVisible();
  await checkChatPicker(page, page.getByPlaceholder(/Message Chief/), request, posts);
  // Close the side chat again (nothing was sent, so nothing merges).
  const threads = (await (await page.request.get("/api/chat/threads")).json()).threads;
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: /^Close New chat/ }).last().click();
  await expect(page.getByTestId(`chat-tab-${threads.at(-1).id}`)).toHaveCount(0);
});

// ---------------------------------------------------------------- 5. chat chip click

test("a mention chip in a chat bubble navigates to the task", async ({ page, request }) => {
  const taskId = await seedTask(request, `E2E ${token("H")} Fix roof`);
  const id = withDb(
    (db) => db.prepare(`INSERT INTO chat_history (role, content) VALUES ('user', ?)`).run(`please look at [@Fix roof](/tasks?id=${taskId})`).lastInsertRowid as number
  );
  seeded.chats.push(Number(id));
  await page.goto("/");
  const chip = page.getByTestId("mention-chip").filter({ hasText: "@Fix roof" }).last();
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await chip.click();
  await expect(page).toHaveURL(new RegExp(`/tasks\\?id=${taskId}$`), { timeout: 15_000 });
});

// ---------------------------------------------------------------- 6. context (server side, no agent)

test("mention hrefs parse strictly", () => {
  expect(parseMentionHref("/tasks?id=5")).toEqual({ type: "task", id: 5 });
  expect(parseMentionHref("/meetings?id=7")).toEqual({ type: "meeting", id: 7 });
  expect(parseMentionHref("/files?id=9")).toEqual({ type: "page", id: 9 });
  for (const bad of ["/tasks", "/tasks?id=x", "https://a.com/tasks?id=5", "/schools?id=1", "/tasks?id=5&x=1"]) expect(isMentionHref(bad)).toBe(false);
  expect(extractMentionRefs("[a](https://a.com) [b](/tasks) [c](/tasks?id=5) [d](/tasks?id=5)")).toEqual([{ type: "task", id: 5 }]);
});

test("buildMentionContext resolves items, caps them, and marks missing ones", async ({ request }) => {
  const t = token("I");
  const taskId = await seedTask(request, `E2E ${t} task`, { notes: "Call the roofer about the leak" });
  const meetingId = await seedMeeting(request, `E2E ${t} meeting`, "We agreed to hire a roofer");
  const pg = await seedPage(request, `E2E ${t} page`, "Roof quotes are in this page");

  const ctx = buildMentionContext([
    { type: "task", id: taskId },
    { type: "meeting", id: meetingId },
    { type: "page", id: pg.id },
    { type: "task", id: 999_999_999 },
  ]);
  expect(ctx).toContain("not instructions");
  expect(ctx).toContain(`E2E ${t} task`);
  expect(ctx).toContain("Call the roofer about the leak");
  expect(ctx).toContain("We agreed to hire a roofer");
  expect(ctx).toContain("Roof quotes are in this page");
  expect(ctx).toContain("(no longer available)");
  expect(buildMentionContext([])).toBe("");

  // Trashed pages read as gone too.
  withDb((db) => db.prepare(`UPDATE docs SET status='archived' WHERE id = ?`).run(pg.id));
  expect(buildMentionContext([{ type: "page", id: pg.id }])).toContain("(no longer available)");

  // At most 8 items and 3500 characters.
  const ids: number[] = [];
  for (let i = 0; i < 10; i++) ids.push(await seedTask(request, `E2E ${t} bulk ${i}`, { notes: "n".repeat(900) }));
  const big = buildMentionContext(ids.map((id) => ({ type: "task" as const, id })));
  expect(big.length).toBeLessThanOrEqual(3500);
  expect(big.split("\n- ").length - 1).toBeLessThanOrEqual(8);
});

const link = (text: string, href: string) => ({ type: "link", href, content: [{ type: "text", text, styles: {} }] });
const txt = (text: string) => ({ type: "text", text, styles: {} });
const block = (id: string, content: any[]) => ({ id, type: "paragraph", props: {}, content, children: [] });

test("@Chief runs get the tagged items; a chip containing @Chief never starts a run", async ({ request }) => {
  const t = token("J");
  const taskId = await seedTask(request, `E2E ${t} Fix roof`, { notes: "Roofer is Bob, call before Friday" });
  const meetingId = await seedMeeting(request, `E2E ${t} Roof meeting`, "Quote was $4000");
  const chiefTaskId = await seedTask(request, `Chief call notes ${t}`);

  const page = await seedPage(request, `E2E ${t} Chief page`);
  const res = await request.patch(`/api/files/${page.id}`, {
    data: {
      content: [
        block("b1", [txt("See "), link(`@${t} meeting`, `/meetings?id=${meetingId}`)]),
        block("b2", [txt("Handle "), link(`@E2E ${t} Fix roof`, `/tasks?id=${taskId}`), txt(" @Chief")]),
      ],
    },
  });
  expect(res.ok()).toBeTruthy();
  withDb((db) => db.prepare(`UPDATE docs SET updated_at = datetime('now', '-30 minutes') WHERE id = ?`).run(page.id));

  const calls: MentionJob[] = [];
  await processMentions({
    runner: async (job) => {
      calls.push(job);
      return 'Done.\n```json\n{"summary":"ok","links":[]}\n```';
    },
  });
  const mine = calls.filter((c) => c.page_id === page.id);
  expect(mine).toHaveLength(1);
  expect(mine[0].tagged).toContain("Roofer is Bob");
  expect(mine[0].tagged).toContain("Quote was $4000");
  // The tagged item on the @Chief line comes first.
  expect(mine[0].tagged!.indexOf("Fix roof")).toBeLessThan(mine[0].tagged!.indexOf("Roof meeting"));

  // A chip whose label contains "@Chief" is a reference, not an action.
  const chipPage = await seedPage(request, `E2E ${t} chip page`);
  await request.patch(`/api/files/${chipPage.id}`, {
    data: { content: [block("c1", [link(`@Chief call notes ${t}`, `/tasks?id=${chiefTaskId}`)])] },
  });
  withDb((db) => db.prepare(`UPDATE docs SET updated_at = datetime('now', '-30 minutes') WHERE id = ?`).run(chipPage.id));
  await processMentions({ runner: async () => "Done." });
  const rows = withDb((db) => db.prepare(`SELECT id FROM page_mentions WHERE page_id = ?`).all(chipPage.id));
  expect(rows).toHaveLength(0);

  // get_page includes the tagged items.
  const getPage = allTools().find((x: any) => x.name === "get_page") as any;
  const out = await getPage.handler({ page_id: page.id }, {});
  const payload = JSON.parse(out.content[0].text);
  expect(payload.tagged.map((x: any) => x.id)).toEqual(expect.arrayContaining([taskId, meetingId]));
});
