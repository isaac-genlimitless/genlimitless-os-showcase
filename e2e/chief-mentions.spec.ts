import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";
import { openTestDb } from "./db-handle";
import { readFileSync } from "fs";
import { join } from "path";
import { withholdToolsForTrigger } from "../src/lib/agents/runtime";
import {
  insertAtMention,
  buildChiefBriefingSection,
  extractMentions,
  markBriefed,
  normalise,
  parseChiefResult,
  processMentions,
  recoverMentionsAtBoot,
  type MentionJob,
} from "../src/lib/chief-mentions";

// "@Chief" action-mentions on Files pages. Nothing here presses Send or starts an agent: the
// 10-minute pass is driven in-process with a STUB runner, and the box tests only seed rows.
// (The isolated test server runs with DISABLE_SCHEDULER, so no real tick ever fires either.)

test.afterEach(() => cleanupFilesPages());

const unique = (label: string) => `E2E Chief ${label} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const LINE = "I need to share my testimony with those closest to me @Chief";

const para = (text: string, id = "b1", type = "paragraph") => ({ id, type, props: {}, content: [{ type: "text", text, styles: {} }], children: [] });

function withDb<T>(fn: (db: ReturnType<typeof openTestDb>) => T): T {
  const db = openTestDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const setUpdated = (id: number, modifier: string) => withDb((db) => db.prepare(`UPDATE docs SET updated_at = datetime('now', ?) WHERE id = ?`).run(modifier, id));
const rowsFor = (pageId: number) => withDb((db) => db.prepare(`SELECT * FROM page_mentions WHERE page_id = ? ORDER BY id`).all(pageId) as any[]);

// Pretend the feature went live long ago, so pages created by these tests are not "baseline".
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

function stub() {
  const calls: MentionJob[] = [];
  const runner = async (job: MentionJob) => {
    calls.push(job);
    return 'Done.\n```json\n{"summary":"Created a task and a calendar block.","links":[{"label":"Tasks","href":"/tasks"}]}\n```';
  };
  return { calls, runner, forPage: (id: number) => calls.filter((c) => c.page_id === id) };
}

async function makePage(request: any, body: string) {
  const { page } = await (await request.post("/api/files", { data: { title: unique("page"), body } })).json();
  return page as { id: number };
}

/** Edit the page the way the editor's autosave does: PATCH its blocks. */
async function editBlocks(request: any, id: number, fn: (blocks: any[]) => any[]) {
  const { blocks } = await (await request.get(`/api/files/${id}`)).json();
  const res = await request.patch(`/api/files/${id}`, { data: { content: fn(blocks) } });
  expect(res.ok()).toBeTruthy();
}
const setText = (blocks: any[], from: string, to: string) =>
  blocks.map((b) => (b.content?.some?.((c: any) => String(c.text).includes(from)) ? { ...b, content: [{ type: "text", text: to, styles: {} }] } : b));

// ---------------------------------------------------------------- 1. detection

test("detects @chief / @Chief / @CHIEF but not look-alikes or code", () => {
  for (const w of ["@chief", "@Chief", "@CHIEF"]) {
    expect(extractMentions("T", [para(`please call mom ${w}`)])).toHaveLength(1);
  }
  expect(extractMentions("T", [para("mail chief@x.com")])).toHaveLength(0);
  expect(extractMentions("T", [para("ask @chiefrey about it")])).toHaveLength(0);
  expect(extractMentions("T", [para("@chief-two is someone else")])).toHaveLength(0);
  expect(extractMentions("T", [{ ...para("@chief do this", "c1", "codeBlock") }])).toHaveLength(0);
  expect(extractMentions("T", [{ id: "x", type: "paragraph", props: {}, content: [{ type: "text", text: "@chief", styles: { code: true } }], children: [] }])).toHaveLength(0);
});

test("two mentions, context, and sentence trimming of long blocks", () => {
  const blocks = [para("one", "a"), para("two", "b"), para("do the first thing @Chief", "c"), para("three", "d"), para("four", "e"), para("five", "f"), para("do the second thing @chief", "g")];
  const m = extractMentions("My page", blocks);
  expect(m).toHaveLength(2);
  expect(m[0].context.before).toEqual(["one", "two"]);
  expect(m[0].context.after).toEqual(["three", "four"]);
  expect(m[0].block_id).toBe("c");
  expect(m[0].mention_key).not.toBe(m[1].mention_key);
  expect(m[0].norm_text).toBe(normalise("do the first thing @Chief"));

  const long = `${"Filler sentence goes here. ".repeat(40)}Book the venue for the retreat @Chief. ${"More filler follows. ".repeat(40)}`;
  const [t] = extractMentions("T", [para(long)]);
  expect(t.mention_text).toBe("Book the venue for the retreat @Chief.");

  const [a, b] = extractMentions("T", [para("same @Chief", "x"), para("same @Chief", "y")]);
  expect(a.mention_key).not.toBe(b.mention_key); // identical text twice = two mentions
});

// ---------------------------------------------------------------- 2. the 10-minute rule

test("runs only after 10 idle minutes, and a save in between restarts the clock", async ({ request }) => {
  const s = stub();
  const p = await makePage(request, `Intro.\n\n${LINE}\n\nOutro.`);

  setUpdated(p.id, "-9 minutes");
  await processMentions({ runner: s.runner });
  expect(s.forPage(p.id)).toHaveLength(0);
  expect(rowsFor(p.id)[0].status).toBe("waiting");

  setUpdated(p.id, "-11 minutes");
  await processMentions({ runner: s.runner });
  expect(s.forPage(p.id)).toHaveLength(1);
  expect(s.forPage(p.id)[0].mention_text).toContain("testimony");
  expect(s.forPage(p.id)[0].page_url).toBe(`/files?id=${p.id}`);

  // Another page: idle for 11 minutes, then an autosave-style PATCH (even identical content) resets it.
  const q = await makePage(request, `Intro.\n\n${LINE}`);
  setUpdated(q.id, "-11 minutes");
  await editBlocks(request, q.id, (b) => b);
  await processMentions({ runner: s.runner });
  expect(s.forPage(q.id)).toHaveLength(0);
});

// ---------------------------------------------------------------- 3. once only

test("each mention runs once; editing the text is a new mention; reverting is not re-run", async ({ request }) => {
  const s = stub();
  const p = await makePage(request, `Intro.\n\n${LINE}`);
  setUpdated(p.id, "-11 minutes");
  await processMentions({ runner: s.runner });
  await processMentions({ runner: s.runner });
  expect(s.forPage(p.id)).toHaveLength(1);
  const row = rowsFor(p.id)[0];
  expect(row.status).toBe("done");
  expect(row.result_text).toContain("Created a task");
  expect(JSON.parse(row.result_links)[0].href).toBe("/tasks");

  // An unrelated edit does not re-run it.
  await editBlocks(request, p.id, (b) => [...b, para("An unrelated new line.", "zz")]);
  setUpdated(p.id, "-11 minutes");
  await processMentions({ runner: s.runner });
  expect(s.forPage(p.id)).toHaveLength(1);

  // Editing the mention's own text makes exactly one new mention.
  const edited = `${LINE} and my family`;
  await editBlocks(request, p.id, (b) => setText(b, "testimony", edited));
  setUpdated(p.id, "-11 minutes");
  await processMentions({ runner: s.runner });
  await processMentions({ runner: s.runner });
  expect(s.forPage(p.id)).toHaveLength(2);

  // Putting the old text back does not re-run the old mention.
  await editBlocks(request, p.id, (b) => setText(b, "testimony", LINE));
  setUpdated(p.id, "-11 minutes");
  await processMentions({ runner: s.runner });
  expect(s.forPage(p.id)).toHaveLength(2);
});

test("a mention edited away before it ran is superseded and never runs", async ({ request }) => {
  const s = stub();
  const p = await makePage(request, `${LINE}`);
  await processMentions({ runner: s.runner }); // recorded as waiting (page is fresh)
  await editBlocks(request, p.id, (b) => setText(b, "testimony", "Nothing to see here."));
  setUpdated(p.id, "-11 minutes");
  await processMentions({ runner: s.runner });
  expect(s.forPage(p.id)).toHaveLength(0);
  expect(rowsFor(p.id)[0].status).toBe("superseded");
});

test("boot recovery: interrupted runs become errors, never-started ones go back to waiting", async ({ request }) => {
  const p = await makePage(request, "Plain page.");
  withDb((db) => {
    const ins = db.prepare(
      `INSERT INTO page_mentions (page_id, mention_key, norm_text, mention_text, status, run_id) VALUES (?, ?, 'x', 'x @chief', 'running', ?)`
    );
    ins.run(p.id, "boot-a", 987654321);
    ins.run(p.id, "boot-b", null);
  });
  recoverMentionsAtBoot();
  const rows = rowsFor(p.id);
  expect(rows.find((r) => r.mention_key === "boot-a")).toMatchObject({ status: "error", error: "Interrupted by a server restart." });
  expect(rows.find((r) => r.mention_key === "boot-b")?.status).toBe("waiting");
});

test("mentions on pages last edited before go-live are baseline and never run", async ({ request }) => {
  const s = stub();
  const p = await makePage(request, LINE);
  setUpdated(p.id, "-100 years");
  await processMentions({ runner: s.runner });
  expect(s.forPage(p.id)).toHaveLength(0);
  expect(rowsFor(p.id)[0].status).toBe("baseline");
});

// ---------------------------------------------------------------- 4. result parsing

test("parseChiefResult: fenced JSON, fallback, and unsafe links dropped", () => {
  const ok = parseChiefResult('All set.\n```json\n{"summary":"Made a task.","links":[{"label":"Tasks","href":"/tasks"},{"label":"Cal","href":"/calendar"}]}\n```');
  expect(ok.summary).toBe("Made a task.");
  expect(ok.links.map((l) => l.href)).toEqual(["/tasks", "/calendar"]);

  const garbage = parseChiefResult("I did some things but forgot the JSON block.");
  expect(garbage.summary).toBe("I did some things but forgot the JSON block.");
  expect(garbage.links).toEqual([]);
  expect(parseChiefResult("```json\n{not json\n```").summary.length).toBeGreaterThan(0);

  const evil = parseChiefResult(
    '```json\n{"summary":"x","links":[{"label":"a","href":"javascript:alert(1)"},{"label":"b","href":"//evil.com"},{"label":"c","href":"https://ok.example/p"},{"label":"d","href":"/files?id=3"}]}\n```'
  );
  expect(evil.links.map((l) => l.href)).toEqual(["https://ok.example/p", "/files?id=3"]);
  const many = parseChiefResult(`\`\`\`json\n${JSON.stringify({ summary: "s", links: Array.from({ length: 9 }, (_, i) => ({ label: "l", href: `/x${i}` })) })}\n\`\`\``);
  expect(many.links).toHaveLength(6);
});

// ---------------------------------------------------------------- 5. the box in the editor

// Also covers legacy rows: the seeding below uses only the existing page_mentions columns (no schema change).
test("result boxes are hover cards on their @Chief mention, never enter the page, survive typing and full screen", async ({ page, request }) => {
  const p = await makePage(request, `Intro line.\n\nFirst @Chief line done\n\nSecond @Chief line running\n\nThird @Chief line broken\n\nOutro line.`);
  const { blocks } = await (await request.get(`/api/files/${p.id}`)).json();
  const idOf = (needle: string) => blocks.find((b: any) => JSON.stringify(b.content).includes(needle)).id as string;
  withDb((db) => {
    const ins = db.prepare(
      `INSERT INTO page_mentions (page_id, mention_key, norm_text, mention_text, block_id, page_title, status, result_text, result_links, error, run_id)
       VALUES (?, ?, ?, ?, ?, 'T', ?, ?, ?, ?, ?)`
    );
    const mk = (key: string, text: string, needle: string, status: string, summary: string | null, links: string | null, err: string | null) =>
      ins.run(p.id, key, normalise(text), text, idOf(needle), status, summary, links, err, null);
    mk("box-1", "First @Chief line done", "First", "done", "Created a task and a calendar block.", JSON.stringify([{ label: "Tasks", href: "/tasks" }]), null);
    mk("box-2", "Second @Chief line running", "Second", "running", null, null, null);
    mk("box-3", "Third @Chief line broken", "Third", "error", null, null, "The calendar was unreachable.");
  });
  const before = withDb((db) => db.prepare(`SELECT body, content, updated_at FROM docs WHERE id=?`).get(p.id) as any);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/files?id=${p.id}`);
  const editor = page.locator(".bn-editor");
  await expect(editor.getByText("First @Chief line done")).toBeVisible({ timeout: 20_000 });
  const boxes = page.getByTestId("chief-mention-box");
  await expect(boxes).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(boxes.nth(i)).toBeHidden();

  const done = page.locator('[data-testid="chief-mention-box"][data-status="done"]');
  const running = page.locator('[data-testid="chief-mention-box"][data-status="running"]');
  const errored = page.locator('[data-testid="chief-mention-box"][data-status="error"]');
  const mentions = page.locator("[data-chief-mention-id]");
  const mentionFor = (status: string) =>
    page.locator(`[data-chief-mention-id="${withDb((db) => (db.prepare(`SELECT id FROM page_mentions WHERE page_id=? AND status=?`).get(p.id, status) as any).id)}"]`);

  await mentionFor("done").hover();
  await expect(done).toBeVisible();
  await expect(done).toContainText("Created a task and a calendar block.");
  await expect(done.getByTestId("chief-mention-link")).toHaveAttribute("href", "/tasks");
  await expect(running).toBeHidden();
  await expect(errored).toBeHidden();

  // The card sits just below its mention and inside the viewport.
  const men = await mentionFor("done").boundingBox();
  const box = await done.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(men!.y + men!.height - 2);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
  expect(box!.y + box!.height).toBeLessThanOrEqual(800);

  await page.mouse.move(5, 5);
  await expect(done).toBeHidden();

  await mentionFor("running").hover();
  await expect(running).toContainText("Chief is on it");
  await mentionFor("error").hover();
  await expect(errored).toContainText("The calendar was unreachable.");
  await expect(page.getByTestId("chief-mention-retry")).toBeVisible();

  // Active mentions are bold, underlined and accent-coloured.
  const accent = await page.evaluate(() => {
    const d = document.createElement("div");
    d.style.color = "var(--accent)";
    document.body.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  });
  for (const s of ["done", "running", "error"]) {
    const m = mentionFor(s).first();
    await expect(m).toHaveClass(/chief-mention-active/);
    const st = await m.evaluate((e) => {
      const c = getComputedStyle(e);
      return { w: Number(c.fontWeight), d: c.textDecorationLine, color: c.color };
    });
    expect(st.w).toBeGreaterThanOrEqual(700);
    expect(st.d).toContain("underline");
    expect(st.color).toBe(accent);
  }
  await expect(mentions).toHaveCount(3);

  // The page itself is untouched by merely viewing it.
  const viewed = withDb((db) => db.prepare(`SELECT body, content, updated_at FROM docs WHERE id=?`).get(p.id) as any);
  expect(viewed).toEqual(before);

  // Typing + autosave: the boxes stay, and none of their text is saved into the page.
  await editor.getByText("Intro line.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" typed");
  await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });
  await expect(boxes).toHaveCount(3);
  const saved = withDb((db) => db.prepare(`SELECT body, content FROM docs WHERE id=?`).get(p.id) as any);
  expect(saved.body).toContain("Intro line. typed");
  expect(saved.body).not.toContain("Created a task");
  expect(saved.content).not.toContain("Chief is on it");
  expect(saved.content).not.toContain("calendar was unreachable");

  // Full screen keeps them.
  await page.getByTestId("files-fullscreen-toggle").click();
  await expect(boxes).toHaveCount(3);
  await page.keyboard.press("Escape");

  // Phone width: no horizontal overflow, boxes still there.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(boxes).toHaveCount(3);
  await mentionFor("error").hover();
  await expect(errored).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // Retry puts the errored one back to waiting (the scheduler is off here, nothing runs).
  await page.getByTestId("chief-mention-retry").click();
  await mentionFor("waiting").hover();
  const waiting = page.locator('[data-testid="chief-mention-box"][data-status="waiting"]');
  await expect(waiting).toContainText("10 min");
  expect(rowsFor(p.id).find((r) => r.mention_key === "box-3")?.status).toBe("waiting");
  await expect(mentionFor("waiting")).not.toHaveClass(/chief-mention-active/);
});

test("deleting the @Chief word removes its card, but the stored row stays", async ({ page, request }) => {
  const p = await makePage(request, `Intro line.\n\nDo the thing @Chief`);
  const { blocks } = await (await request.get(`/api/files/${p.id}`)).json();
  const bid = blocks.find((b: any) => JSON.stringify(b.content).includes("Do the thing")).id as string;
  withDb((db) =>
    db
      .prepare(
        `INSERT INTO page_mentions (page_id, mention_key, norm_text, mention_text, block_id, page_title, status, result_text, result_links, error, run_id)
         VALUES (?, 'del-1', ?, ?, ?, 'T', 'done', 'All done.', NULL, NULL, NULL)`
      )
      .run(p.id, normalise("Do the thing @Chief"), "Do the thing @Chief", bid)
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/files?id=${p.id}`);
  const editor = page.locator(".bn-editor");
  await expect(editor.getByText("Do the thing")).toBeVisible({ timeout: 20_000 });
  const cards = page.getByTestId("chief-mention-box");
  await expect(cards).toHaveCount(1);
  await page.locator(".chief-mention").first().hover();
  await expect(cards.first()).toBeVisible();

  await editor.getByText("Do the thing").click();
  await page.keyboard.press("End");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace");
  await expect(cards).toHaveCount(0);
  await expect(page.locator(".chief-mention")).toHaveCount(0);
  expect(rowsFor(p.id)).toHaveLength(1); // nothing deleted
});

test.describe("touch", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("tap toggles the card, tapping elsewhere closes it", async ({ page, request }) => {
    const p = await makePage(request, `Intro line.\n\nDo the thing @Chief`);
    const { blocks } = await (await request.get(`/api/files/${p.id}`)).json();
    const bid = blocks.find((b: any) => JSON.stringify(b.content).includes("Do the thing")).id as string;
    withDb((db) =>
      db
        .prepare(
          `INSERT INTO page_mentions (page_id, mention_key, norm_text, mention_text, block_id, page_title, status, result_text, result_links, error, run_id)
           VALUES (?, 'touch-1', ?, ?, ?, 'T', 'done', 'All done.', NULL, NULL, NULL)`
        )
        .run(p.id, normalise("Do the thing @Chief"), "Do the thing @Chief", bid)
    );
    await page.goto(`/files?id=${p.id}`);
    const editor = page.locator(".bn-editor");
    await expect(editor.getByText("Do the thing")).toBeVisible({ timeout: 20_000 });
    const card = page.getByTestId("chief-mention-box");
    const mention = page.locator(".chief-mention").first();
    await mention.tap();
    await expect(card).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await mention.tap();
    await expect(card).toBeHidden();
    await mention.tap();
    await expect(card).toBeVisible();
    await editor.getByText("Intro line.").tap();
    await expect(card).toBeHidden();
  });
});

// ---------------------------------------------------------------- 6. briefing

test("briefing section lists finished mentions once, with links and errors, and is empty otherwise", async ({ request }) => {
  const p = await makePage(request, "Plain page.");
  const drain = buildChiefBriefingSection();
  markBriefed(drain.ids); // other tests' finished rows are not part of this check

  expect(buildChiefBriefingSection().text).toBe("");

  withDb((db) => {
    const ins = db.prepare(
      `INSERT INTO page_mentions (page_id, mention_key, norm_text, mention_text, page_title, status, result_text, result_links, error, finished_at)
       VALUES (?, ?, ?, ?, 'My notes', ?, ?, ?, ?, datetime('now'))`
    );
    ins.run(p.id, "brief-1", "a", LINE, "done", "Created a task and a calendar block.", JSON.stringify([{ label: "Tasks", href: "/tasks" }]), null);
    ins.run(p.id, "brief-2", "b", "Book the hall @Chief", "error", null, null, "The calendar was unreachable.");
  });

  const first = buildChiefBriefingSection();
  expect(first.ids).toHaveLength(2);
  expect(first.text).toContain("@Chief actions");
  expect(first.text).toContain(`/files?id=${p.id}`);
  expect(first.text).toContain("share my testimony");
  expect(first.text).toContain("Created a task and a calendar block.");
  expect(first.text).toContain("(/tasks)");
  expect(first.text).toContain("couldn't finish");
  expect(first.text).toContain("The calendar was unreachable.");

  markBriefed(first.ids);
  expect(buildChiefBriefingSection()).toEqual({ text: "", ids: [] });
});

// ---------------------------------------------------------------- 7. insert_at_mention

const textOf = (b: any) => (Array.isArray(b.content) ? b.content.map((c: any) => (c.type === "link" ? c.content.map((x: any) => x.text).join("") : c.text)).join("") : "");
const getBlocks = async (request: any, id: number) => (await (await request.get(`/api/files/${id}`)).json()).blocks as any[];

function inserter(markdown: string) {
  const calls: MentionJob[] = [];
  const runner = async (job: MentionJob) => {
    calls.push(job);
    await insertAtMention(job.page_id, markdown);
    return 'Done.\n```json\n{"summary":"Inserted the quote at the [] on this line.","links":[]}\n```';
  };
  return { calls, runner };
}

test("insert_at_mention fills the [] in place, touches nothing else, and does not re-run", async ({ request }) => {
  const p = await makePage(request, "Intro line.\n\nPlease insert the Nelson quote here [] thanks @Chief\n\nOutro line.");
  setUpdated(p.id, "-11 minutes");
  const before = await getBlocks(request, p.id);
  const s = inserter('He said "Hello." [Source](https://example.com/q)');
  await processMentions({ runner: s.runner });
  expect(s.calls.filter((c) => c.page_id === p.id)).toHaveLength(1);

  const after = await getBlocks(request, p.id);
  expect(after).toHaveLength(before.length);
  const idx = after.findIndex((b) => textOf(b).includes("@Chief"));
  expect(textOf(after[idx])).toBe('Please insert the Nelson quote here He said "Hello." Source thanks @Chief');
  expect(textOf(after[idx])).not.toContain("[]");
  expect(JSON.stringify(after[idx].content)).toContain("https://example.com/q");
  for (let i = 0; i < before.length; i++) if (i !== idx) expect(after[i]).toEqual(before[i]);

  // re-run safety: the edited line is the same mention, not a new one
  setUpdated(p.id, "-11 minutes");
  await processMentions({ runner: s.runner });
  expect(s.calls.filter((c) => c.page_id === p.id)).toHaveLength(1);
  const rows = rowsFor(p.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("done");
  expect(rows.filter((r) => r.status === "waiting")).toHaveLength(0);
});

test("insert_at_mention adds one block right below the line when there is no []", async ({ request }) => {
  const p = await makePage(request, "Before.\n\nAdd the link here @Chief\n\nAfter.");
  setUpdated(p.id, "-11 minutes");
  const before = await getBlocks(request, p.id);
  const s = inserter("[Example](https://example.com/page)");
  await processMentions({ runner: s.runner });
  const after = await getBlocks(request, p.id);
  expect(after).toHaveLength(before.length + 1);
  const idx = after.findIndex((b) => textOf(b).includes("@Chief"));
  expect(JSON.stringify(after[idx + 1].content)).toContain("https://example.com/page");
  const rest = after.filter((_, i) => i !== idx + 1);
  expect(rest).toEqual(before);
});

test("insert_at_mention guards: no running mention, no @Chief in the text", async ({ request }) => {
  const p = await makePage(request, "Keep [] this @Chief");
  const before = await getBlocks(request, p.id);
  await expect(insertAtMention(p.id, "hello")).rejects.toThrow(/only works while handling/);
  withDb((db) =>
    db
      .prepare(`INSERT INTO page_mentions (page_id, mention_key, norm_text, mention_text, block_id, page_title, status) VALUES (?, 'g-1', 'x', 'x', ?, 'T', 'running')`)
      .run(p.id, before[0].id)
  );
  await expect(insertAtMention(p.id, "ask @Chief again")).rejects.toThrow(/@Chief/);
  expect(await getBlocks(request, p.id)).toEqual(before);
});

test("mention runs lose update_page and the prompt tells the agent to use insert_at_mention", () => {
  const set = withholdToolsForTrigger("page_mention", new Set(["update_page", "create_page"]));
  expect(set.has("update_page")).toBe(false);
  expect(set.has("create_page")).toBe(true);
  expect(withholdToolsForTrigger("chat", new Set(["update_page"])).has("update_page")).toBe(true);
  const src = readFileSync(join(process.cwd(), "src/lib/agents/runtime.ts"), "utf8");
  expect(src).toContain("insert_at_mention");
  expect(src).not.toContain("Do NOT edit the source page");
});

test("an open editor picks up a server-side change without reload", async ({ page, request }) => {
  test.setTimeout(150_000);
  const p = await makePage(request, "Intro line.\n\nDone @Chief line\n\nOutro line.");
  const blocks = await getBlocks(request, p.id);
  withDb((db) =>
    db
      .prepare(`INSERT INTO page_mentions (page_id, mention_key, norm_text, mention_text, block_id, page_title, status, result_text) VALUES (?, 'ed-1', 'done @chief line', 'Done @Chief line', ?, 'T', 'done', 'ok')`)
      .run(p.id, blocks[1].id)
  );
  await page.goto(`/files?id=${p.id}`);
  const editor = page.locator(".bn-editor");
  await expect(editor.getByText("Intro line.")).toBeVisible({ timeout: 20_000 });
  await new Promise((r) => setTimeout(r, 1500)); // let the first poll record the page stamp
  await new Promise((r) => setTimeout(r, 1100)); // updated_at has one-second resolution
  const res = await request.patch(`/api/files/${p.id}`, { data: { content: setText(blocks, "Outro", "Outro line. Inserted by Chief.") } });
  expect(res.ok()).toBeTruthy();
  await expect(editor.getByText("Inserted by Chief.")).toBeVisible({ timeout: 90_000 });
});
