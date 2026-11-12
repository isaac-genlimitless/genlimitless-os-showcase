import crypto from "crypto";
import db, { jobAlreadyRan, recordJobRun, logIssue } from "./db";
import { currentBlocks, getPage, pageUrl, updatePage, type Page } from "./pages";
import { markdownToBlocks } from "./blocks";
import { buildMentionContext, extractMentionRefsFromBlocks, isMentionHref, type MentionRef } from "./mentions";

// "@Chief" action-mentions on Files pages. Owner writes a line like
//   "I need to share my testimony with those closest to me @Chief"
// and stops editing; once the page has been idle for CHIEF_QUIET_MINUTES the Chief of Staff acts
// on it ONCE, and the outcome shows in a box under that line (rendered from page_mentions by the
// editor, never stored in the page itself) and in the next morning briefing.
//
// Rules this file enforces: the page's own updated_at is the "last edited" clock (it only moves on
// title/body/content changes); a mention is identified by its normalised text (editing the text =
// a new mention, an untouched one never re-runs); rows are never deleted; mentions that already
// existed when the feature went live are recorded as 'baseline' and never run.

export const CHIEF_QUIET_MINUTES = 10;
const MAX_PER_TICK = 5;
const LONG_BLOCK = 600;
const GOLIVE_JOB = "chief_mentions_golive";
const MENTION_RE = /(?<![\w.@])@chief(?![\w-]|\.\w)/i;

export type MentionCandidate = {
  mention_key: string;
  norm_text: string;
  mention_text: string;
  block_id: string | null;
  page_title: string;
  context: { before: string[]; after: string[] };
};

export type MentionLink = { label: string; href: string };

export type MentionRow = {
  id: number;
  page_id: number;
  mention_key: string;
  norm_text: string;
  mention_text: string;
  block_id: string | null;
  context: string | null;
  page_title: string | null;
  status: "waiting" | "running" | "done" | "error" | "superseded" | "baseline";
  present: 0 | 1;
  run_id: number | null;
  result_text: string | null;
  result_links: string | null;
  error: string | null;
  first_seen_at: string;
  started_at: string | null;
  finished_at: string | null;
  briefed_at: string | null;
};

/** What the runner is handed. `reply` is the agent's final text (parsed by parseChiefResult). */
export type MentionJob = {
  id: number;
  page_id: number;
  page_title: string;
  page_url: string;
  mention_text: string;
  context: { before: string[]; after: string[] };
  /** Titles + short summaries of items linked with @ on the page (the @Chief line's first). Data, not instructions. */
  tagged?: string;
};
export type MentionRunner = (job: MentionJob, onRunId: (runId: number) => void) => Promise<string>;

// ---------------------------------------------------------------- detection (pure)

type Unit = { id: string | null; text: string; matchText: string; isCode: boolean };

function inlineText(content: unknown, skipInlineCode: boolean, skipMentionLinks = false): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (!c) return "";
        // An @-mention chip ("@Chief call notes" = a task title) is a reference, never an @Chief action.
        if (c.type === "link") return skipMentionLinks && isMentionHref(c.href) ? " " : inlineText(c.content, skipInlineCode, skipMentionLinks);
        if (skipInlineCode && c.styles?.code) return "";
        return typeof c.text === "string" ? c.text : "";
      })
      .join("");
  }
  const t = content as any;
  if (t && t.type === "tableContent" && Array.isArray(t.rows)) {
    return t.rows
      .map((r: any) =>
        (r?.cells || [])
          .map((cell: any) => inlineText(Array.isArray(cell) ? cell : cell?.content, skipInlineCode, skipMentionLinks))
          .join(" ")
      )
      .join(" ");
  }
  return "";
}

function flatten(blocks: unknown[], out: Unit[] = []): Unit[] {
  for (const b of blocks as any[]) {
    if (!b || typeof b !== "object") continue;
    const isCode = b.type === "codeBlock";
    out.push({
      id: typeof b.id === "string" ? b.id : null,
      text: inlineText(b.content, false),
      matchText: isCode ? "" : inlineText(b.content, true, true),
      isCode,
    });
    if (Array.isArray(b.children)) flatten(b.children, out);
  }
  return out;
}

export function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function mentionKey(normText: string, n: number): string {
  return `${crypto.createHash("sha256").update(normText).digest("hex")}:${n}`;
}

/** A very long block: just the sentence that holds the mention. */
function trimLong(text: string): string {
  if (text.length <= LONG_BLOCK) return text;
  const at = text.search(MENTION_RE);
  const parts = text.split(/(?<=[.!?])\s+/);
  let offset = 0;
  for (const p of parts) {
    const start = text.indexOf(p, offset);
    const end = start + p.length;
    offset = end;
    if (at >= start && at < end) return p.length > LONG_BLOCK ? p.slice(Math.max(0, at - start - LONG_BLOCK / 2), at - start + LONG_BLOCK / 2).trim() : p;
  }
  return text.slice(Math.max(0, at - LONG_BLOCK / 2), at + LONG_BLOCK / 2).trim();
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Every @Chief line on a page: one mention per block that contains it (never inside code). */
export function extractMentions(title: string, blocks: unknown[]): MentionCandidate[] {
  const units = flatten(blocks);
  const seen = new Map<string, number>();
  const out: MentionCandidate[] = [];
  units.forEach((u, i) => {
    if (u.isCode || !MENTION_RE.test(u.matchText)) return;
    const text = trimLong(u.text.trim());
    const norm = normalise(text);
    const n = (seen.get(norm) ?? 0) + 1;
    seen.set(norm, n);
    const ctx = (list: Unit[]) => list.map((x) => clip(x.text.trim(), 300)).filter(Boolean);
    out.push({
      mention_key: mentionKey(norm, n),
      norm_text: norm,
      mention_text: text,
      block_id: u.id,
      page_title: title,
      context: { before: ctx(units.slice(Math.max(0, i - 2), i)), after: ctx(units.slice(i + 1, i + 3)) },
    });
  });
  return out;
}

// ---------------------------------------------------------------- result parsing

function safeHref(h: unknown): string | null {
  if (typeof h !== "string") return null;
  const s = h.trim();
  if (/^\/(?![\/\\])/.test(s) || /^https:\/\//i.test(s)) return s.slice(0, 500);
  return null;
}

/** Pulls the closing {"summary","links"} block out of the agent's reply. Never throws. */
export function parseChiefResult(text: string): { summary: string; links: MentionLink[] } {
  const raw = String(text ?? "");
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  for (const body of fences.reverse()) {
    try {
      const j = JSON.parse(body.trim());
      if (j && typeof j === "object" && typeof j.summary === "string" && j.summary.trim()) {
        const links: MentionLink[] = [];
        for (const l of Array.isArray(j.links) ? j.links : []) {
          const href = safeHref(l?.href);
          if (href && links.length < 6) links.push({ label: clip(String(l?.label ?? href).trim() || href, 60), href });
        }
        return { summary: clip(j.summary.trim(), 500), links };
      }
    } catch {
      /* try the next block */
    }
  }
  const plain = raw.replace(/```[\s\S]*?```/g, "").trim() || raw.trim();
  return { summary: clip(plain, 300) || "Done (no summary was returned).", links: [] };
}

// ---------------------------------------------------------------- go-live baseline

const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

/** When this feature first ran. Pages last edited before this keep their old @Chief notes as
 *  'baseline' (never run) unless CHIEF_MENTIONS_BACKFILL=true. */
function goLiveTime(): string {
  if (process.env.CHIEF_MENTIONS_BACKFILL === "true") return "0000-00-00 00:00:00";
  if (!jobAlreadyRan(GOLIVE_JOB, "v1")) recordJobRun(GOLIVE_JOB, "v1");
  const r = db.prepare(`SELECT created_at FROM job_runs WHERE job=? AND run_key='v1'`).get(GOLIVE_JOB) as { created_at: string } | undefined;
  return r?.created_at ?? sqlTime(new Date());
}

// ---------------------------------------------------------------- targeted page edit

type Loc = { arr: any[]; idx: number };

function findBlock(blocks: any[], pred: (b: any) => boolean): Loc | null {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b && pred(b)) return { arr: blocks, idx: i };
    if (b && Array.isArray(b.children)) {
      const r = findBlock(b.children, pred);
      if (r) return r;
    }
  }
  return null;
}

const PLACEHOLDER_RE = /\[\s*\]/;

function placeholderIndex(content: unknown): number {
  if (!Array.isArray(content)) return -1;
  return content.findIndex((c: any) => c && c.type === "text" && !c.styles?.code && typeof c.text === "string" && PLACEHOLDER_RE.test(c.text));
}

/**
 * Edit the page of the @Chief mention being handled, at that one line only: fill the first empty "[]"
 * on the line, or add the content as new block(s) right below it. Nothing else on the page may change
 * (checked before writing). Re-keys the running mention row so the edited line isn't seen as a new mention.
 */
export async function insertAtMention(
  pageId: number,
  markdown: string,
  mode: "auto" | "placeholder" | "below" = "auto"
): Promise<{ inserted: string; where: "placeholder" | "below"; block_id: string | null }> {
  const row = db
    .prepare(`SELECT * FROM page_mentions WHERE page_id=? AND status='running' AND present=1 ORDER BY id LIMIT 1`)
    .get(pageId) as MentionRow | undefined;
  if (!row) throw new Error("insert_at_mention only works while handling an @Chief line on that page");
  if (typeof markdown !== "string" || !markdown.trim()) throw new Error("insert_at_mention: markdown is empty");
  if (markdown.length > 5000) throw new Error("insert_at_mention: markdown is too long (max 5000 characters)");
  if (MENTION_RE.test(markdown)) throw new Error("insert_at_mention: the inserted text cannot contain an @Chief mention");

  const page = getPage(pageId);
  if (!page) throw new Error("Page not found");
  const original = (await currentBlocks(page)) as any[];
  const next = JSON.parse(JSON.stringify(original)) as any[];

  const keyOf = (b: any) => {
    const m = extractMentions(page.title, [{ ...b, children: [] }])[0];
    return m?.mention_key;
  };
  const locate = (blocks: any[]) =>
    (row.block_id ? findBlock(blocks, (b) => b.id === row.block_id) : null) ??
    findBlock(blocks, (b) => keyOf(b) === row.mention_key);
  const locOrig = locate(original);
  const loc = locate(next);
  if (!locOrig || !loc) throw new Error("insert_at_mention: could not find the @Chief line on the page; nothing changed");
  const target = loc.arr[loc.idx];
  const origTarget = locOrig.arr[locOrig.idx];

  const parsed = (await markdownToBlocks(markdown)) as any[];
  if (!parsed.length) throw new Error("insert_at_mention: nothing to insert");

  const phIdx = placeholderIndex(target.content);
  const usePlaceholder = mode === "placeholder" || (mode === "auto" && phIdx >= 0);
  if (usePlaceholder && phIdx < 0) throw new Error("insert_at_mention: no empty [] on that line");

  let where: "placeholder" | "below";
  let extras: any[];
  let insertedText = "";
  let expectedText: string | null = null;
  if (usePlaceholder) {
    where = "placeholder";
    const first = parsed[0];
    if (!Array.isArray(first?.content)) throw new Error("insert_at_mention: the text to insert has no inline content");
    const item = target.content[phIdx];
    const m = PLACEHOLDER_RE.exec(item.text)!;
    const before = item.text.slice(0, m.index);
    const after = item.text.slice(m.index + m[0].length);
    const mid = first.content as any[];
    insertedText = inlineText(mid, false);
    const pieces: any[] = [];
    if (before) pieces.push({ ...item, text: before });
    pieces.push(...mid);
    if (after) pieces.push({ ...item, text: after });
    target.content = [...target.content.slice(0, phIdx), ...pieces, ...target.content.slice(phIdx + 1)];
    extras = parsed.slice(1);
    loc.arr.splice(loc.idx + 1, 0, ...extras);
    expectedText = inlineText(origTarget.content, false).replace(m[0], "");
  } else {
    where = "below";
    extras = parsed;
    insertedText = extras.map((b) => inlineText(b.content, false)).join(" ");
    loc.arr.splice(loc.idx + 1, 0, ...extras);
  }

  // Invariant: everything except the target and the inserted blocks is untouched.
  const without = (blocks: any[], drop: Set<any>): any[] =>
    blocks.filter((b) => !drop.has(b)).map((b) => (Array.isArray(b?.children) ? { ...b, children: without(b.children, drop) } : b));
  const dropNew = new Set<any>([target, ...extras]);
  const dropOld = new Set<any>([origTarget]);
  if (JSON.stringify(without(next, dropNew)) !== JSON.stringify(without(original, dropOld))) {
    throw new Error("insert_at_mention: safety check failed (other page content would change); nothing written");
  }
  if (JSON.stringify(target.children ?? null) !== JSON.stringify(origTarget.children ?? null) || target.id !== origTarget.id) {
    throw new Error("insert_at_mention: safety check failed (line structure changed); nothing written");
  }
  if (where === "placeholder") {
    const got = inlineText(target.content, false);
    const idx = got.indexOf(insertedText);
    const rest = idx < 0 ? null : got.slice(0, idx) + got.slice(idx + insertedText.length);
    if (rest === null || rest !== expectedText) {
      throw new Error("insert_at_mention: safety check failed (line text mismatch); nothing written");
    }
  } else if (JSON.stringify(target) !== JSON.stringify(origTarget)) {
    throw new Error("insert_at_mention: safety check failed (line changed); nothing written");
  }

  await updatePage(page.id, { content: next });

  try {
    const fresh = getPage(page.id)!;
    const m = extractMentions(fresh.title, next).find((x) => x.block_id === row.block_id);
    if (!m) throw new Error("mention not found after edit");
    db.transaction(() => {
      db.prepare(`UPDATE page_mentions SET mention_key=?, norm_text=?, mention_text=?, context=?, block_id=? WHERE id=?`).run(
        m.mention_key,
        m.norm_text,
        m.mention_text,
        JSON.stringify(m.context),
        m.block_id,
        row.id
      );
    })();
  } catch (e) {
    logIssue("chief_mentions:rekey", `Could not re-key mention ${row.id} on page ${page.id}: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { inserted: insertedText.slice(0, 200), where, block_id: row.block_id };
}

// ---------------------------------------------------------------- sync + dispatch

async function syncPage(page: Page, live: string) {
  const found = extractMentions(page.title, await currentBlocks(page));
  const keys = new Set(found.map((m) => m.mention_key));
  const get = db.prepare(`SELECT id, status FROM page_mentions WHERE page_id=? AND mention_key=?`);
  const insert = db.prepare(
    `INSERT INTO page_mentions (page_id, mention_key, norm_text, mention_text, block_id, context, page_title, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const refresh = db.prepare(`UPDATE page_mentions SET present=1, block_id=?, mention_text=?, context=?, page_title=? WHERE id=?`);
  const revive = db.prepare(`UPDATE page_mentions SET status='waiting' WHERE id=? AND status='superseded'`);
  const baseline = page.updated_at < live;
  db.transaction(() => {
    for (const m of found) {
      const ctx = JSON.stringify(m.context);
      const ex = get.get(page.id, m.mention_key) as { id: number; status: string } | undefined;
      if (!ex) insert.run(page.id, m.mention_key, m.norm_text, m.mention_text, m.block_id, ctx, m.page_title, baseline ? "baseline" : "waiting");
      else {
        refresh.run(m.block_id, m.mention_text, ctx, m.page_title, ex.id);
        revive.run(ex.id); // it never ran (edited away, then put back), so it may still run
      }
    }
    const here = db.prepare(`SELECT id, mention_key, status FROM page_mentions WHERE page_id=? AND present=1`).all(page.id) as { id: number; mention_key: string; status: string }[];
    for (const r of here) {
      if (keys.has(r.mention_key) || r.status === "running") continue;
      if (r.status === "waiting") db.prepare(`UPDATE page_mentions SET status='superseded', present=0 WHERE id=?`).run(r.id);
      else db.prepare(`UPDATE page_mentions SET present=0 WHERE id=?`).run(r.id);
    }
  })();
}

function finish(id: number, patch: { status: "done" | "error"; result_text?: string; result_links?: MentionLink[]; error?: string }) {
  db.prepare(
    `UPDATE page_mentions SET status=?, result_text=?, result_links=?, error=?, finished_at=datetime('now') WHERE id=?`
  ).run(patch.status, patch.result_text ?? null, patch.result_links ? JSON.stringify(patch.result_links) : null, patch.error ?? null, id);
}

async function defaultRunner(job: MentionJob, onRunId: (runId: number) => void): Promise<string> {
  const { runMention } = await import("./agents/runtime");
  return runMention(job, onRunId);
}

let processing = false;

/** One pass: sync every page that mentions @Chief, then run (at most 5) waiting mentions whose page
 *  has been idle for 10 minutes. `runner` is injectable so tests never start a real agent. */
export async function processMentions(opts: { now?: Date; runner?: MentionRunner } = {}): Promise<{ scanned: number; ran: number }> {
  if (processing) return { scanned: 0, ran: 0 };
  processing = true;
  try {
    const now = opts.now ?? new Date();
    const runner = opts.runner ?? defaultRunner;
    const live = goLiveTime();
    const pages = db
      .prepare(
        `SELECT * FROM docs WHERE status='active' AND kind IN ('page','meeting')
           AND (body LIKE '%@chief%' OR id IN (SELECT page_id FROM page_mentions WHERE present=1))`
      )
      .all() as Page[];
    for (const p of pages) {
      try {
        await syncPage(p, live);
      } catch (err: any) {
        logIssue("chief_mentions:scan", `Couldn't scan page ${p.id} for @Chief`, err.message);
      }
    }

    const cutoff = sqlTime(new Date(now.getTime() - CHIEF_QUIET_MINUTES * 60_000));
    const due = db
      .prepare(
        `SELECT m.* FROM page_mentions m JOIN docs d ON d.id = m.page_id
          WHERE m.status='waiting' AND m.present=1 AND d.status='active' AND d.updated_at <= ?
          ORDER BY m.id LIMIT 20`
      )
      .all(cutoff) as MentionRow[];

    let ran = 0;
    for (const row of due) {
      if (ran >= MAX_PER_TICK) break;
      // Re-read right before starting: an edit made in the meantime restarts the 10 minutes, and a
      // mention whose text changed is a different mention and must not run.
      const page = getPage(row.page_id);
      if (!page || page.status !== "active" || page.updated_at > cutoff) continue;
      const pageBlocks = await currentBlocks(page);
      const fresh = extractMentions(page.title, pageBlocks).find((m) => m.mention_key === row.mention_key);
      if (!fresh) {
        db.prepare(`UPDATE page_mentions SET status='superseded', present=0 WHERE id=? AND status='waiting'`).run(row.id);
        continue;
      }
      const claim = db.prepare(`UPDATE page_mentions SET status='running', started_at=datetime('now') WHERE id=? AND status='waiting'`).run(row.id);
      if (claim.changes !== 1) continue;
      ran++;
      const job: MentionJob = {
        id: row.id,
        page_id: page.id,
        page_title: page.title,
        page_url: pageUrl(page.id),
        mention_text: fresh.mention_text,
        context: fresh.context,
      };
      try {
        const lineBlock = fresh.block_id ? findBlock(pageBlocks as any[], (b) => b.id === fresh.block_id) : null;
        const onLine: MentionRef[] = lineBlock ? extractMentionRefsFromBlocks([{ ...lineBlock.arr[lineBlock.idx], children: [] }]) : [];
        const seen = new Set(onLine.map((r) => `${r.type}:${r.id}`));
        const refs = [...onLine, ...extractMentionRefsFromBlocks(pageBlocks).filter((r) => !seen.has(`${r.type}:${r.id}`))];
        const tagged = buildMentionContext(refs);
        if (tagged) job.tagged = tagged;
      } catch (e) {
        logIssue("chief_mentions:tagged", `Couldn't resolve tagged items for page ${page.id}`, e instanceof Error ? e.message : String(e));
      }
      try {
        const reply = await runner(job, (runId) => db.prepare(`UPDATE page_mentions SET run_id=? WHERE id=?`).run(runId, row.id));
        const cur = db.prepare(`SELECT run_id FROM page_mentions WHERE id=?`).get(row.id) as { run_id: number | null };
        const run = cur.run_id ? (db.prepare(`SELECT status, summary FROM agent_runs WHERE id=?`).get(cur.run_id) as { status: string; summary: string | null } | undefined) : undefined;
        if (run && run.status === "error") finish(row.id, { status: "error", error: clip(run.summary || "The run didn't finish.", 300) });
        else {
          const r = parseChiefResult(reply);
          finish(row.id, { status: "done", result_text: r.summary, result_links: r.links });
        }
      } catch (err: any) {
        finish(row.id, { status: "error", error: clip(String(err?.message ?? err), 300) });
        logIssue("chief_mentions:run", `@Chief action on page ${page.id} failed`, err?.message);
      }
    }
    return { scanned: pages.length, ran };
  } finally {
    processing = false;
  }
}

// ---------------------------------------------------------------- restart safety

/** Runs once at boot, before the first tick. A run that finished while we were down is finalised
 *  from its summary; an interrupted one becomes an error (Owner can press Retry: a half-done run
 *  is never silently re-run, it could duplicate a task); one that never started goes back to waiting. */
export function recoverMentionsAtBoot(): { finalised: number; errored: number; requeued: number } {
  const out = { finalised: 0, errored: 0, requeued: 0 };
  const rows = db.prepare(`SELECT id, run_id FROM page_mentions WHERE status='running'`).all() as { id: number; run_id: number | null }[];
  for (const r of rows) {
    if (!r.run_id) {
      db.prepare(`UPDATE page_mentions SET status='waiting', started_at=NULL WHERE id=?`).run(r.id);
      out.requeued++;
      continue;
    }
    const run = db.prepare(`SELECT status, summary FROM agent_runs WHERE id=?`).get(r.run_id) as { status: string; summary: string | null } | undefined;
    if (run?.status === "done") {
      const p = parseChiefResult(run.summary || "");
      finish(r.id, { status: "done", result_text: p.summary, result_links: p.links });
      out.finalised++;
    } else {
      finish(r.id, { status: "error", error: "Interrupted by a server restart." });
      out.errored++;
    }
  }
  return out;
}

/** Owner pressed Retry on an errored mention. */
export function retryMention(id: number, pageId?: number): boolean {
  const r = db
    .prepare(
      `UPDATE page_mentions SET status='waiting', error=NULL, result_text=NULL, result_links=NULL, run_id=NULL,
         started_at=NULL, finished_at=NULL, briefed_at=NULL WHERE id=? AND status='error'${pageId ? " AND page_id=?" : ""}`
    )
    .run(...(pageId ? [id, pageId] : [id]));
  return r.changes === 1;
}

// ---------------------------------------------------------------- reads for the editor

export type PageMentionView = {
  id: number;
  status: "waiting" | "running" | "done" | "error";
  block_id: string | null;
  mention_text: string;
  norm_text: string;
  summary: string | null;
  links: MentionLink[];
  error: string | null;
  run_id: number | null;
};

/** Lines the server deliberately never runs (written before go-live): the editor must not turn them blue. */
export function listIgnoredMentions(pageId: number): { block_id: string | null; norm_text: string }[] {
  return db
    .prepare(`SELECT block_id, norm_text FROM page_mentions WHERE page_id=? AND present=1 AND status='baseline' ORDER BY id`)
    .all(pageId) as { block_id: string | null; norm_text: string }[];
}

export function listPageMentions(pageId: number): PageMentionView[] {
  const rows = db
    .prepare(`SELECT * FROM page_mentions WHERE page_id=? AND present=1 AND status IN ('waiting','running','done','error') ORDER BY id`)
    .all(pageId) as MentionRow[];
  return rows.map((r) => {
    let links: MentionLink[] = [];
    try {
      const p = JSON.parse(r.result_links || "[]");
      if (Array.isArray(p)) links = p.map((l: any) => ({ label: String(l.label), href: safeHref(l.href) || "" })).filter((l) => l.href);
    } catch {
      /* none */
    }
    return {
      id: r.id,
      status: r.status as PageMentionView["status"],
      block_id: r.block_id,
      mention_text: r.mention_text,
      norm_text: r.norm_text,
      summary: r.result_text,
      links,
      error: r.error,
      run_id: r.run_id,
    };
  });
}

// ---------------------------------------------------------------- briefing

const oneLine = (s: string, n: number) => clip(s.replace(/[\[\]()`*_<>]/g, "").replace(/\s+/g, " ").trim(), n);

/** The "@Chief actions" section for the morning briefing, built in code (never by the model) from
 *  finished mentions that haven't been reported yet. Call markBriefed(ids) when it is posted. */
export function buildChiefBriefingSection(): { text: string; ids: number[] } {
  const rows = db
    .prepare(`SELECT * FROM page_mentions WHERE status IN ('done','error') AND briefed_at IS NULL ORDER BY finished_at, id`)
    .all() as MentionRow[];
  if (!rows.length) return { text: "", ids: [] };
  const lines = rows.map((r) => {
    const links = (() => {
      try {
        return (JSON.parse(r.result_links || "[]") as MentionLink[]).filter((l) => safeHref(l.href)).map((l) => `[${oneLine(l.label, 40)}](${l.href})`);
      } catch {
        return [];
      }
    })();
    const head = `- [${oneLine(r.page_title || `Page ${r.page_id}`, 80)}](${pageUrl(r.page_id)}): you wrote "${oneLine(r.mention_text, 160)}"`;
    return r.status === "error"
      ? `${head}\n  ⚠️ Chief couldn't finish: ${oneLine(r.error || "unknown error", 200)} (Retry is on the page.)`
      : `${head}\n  Chief: ${oneLine(r.result_text || "done", 300)}${links.length ? ` ${links.join(" · ")}` : ""}`;
  });
  return { text: `**@Chief actions** (since the last briefing)\n${lines.join("\n")}`, ids: rows.map((r) => r.id) };
}

export function markBriefed(ids: number[]) {
  const up = db.prepare(`UPDATE page_mentions SET briefed_at=datetime('now') WHERE id=? AND briefed_at IS NULL`);
  db.transaction(() => ids.forEach((id) => up.run(id)))();
}
