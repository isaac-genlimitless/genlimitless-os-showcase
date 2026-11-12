import crypto from "crypto";
import fs from "fs";
import path from "path";
import db, { Doc } from "./db";
import { DATA_DIR } from "./data-dir";
import { blocksToMarkdown, markdownToBlocks } from "./blocks";
import { applyPageEdits, type PageEdit } from "./page-edit";

// The Files workspace (Notion-style): one tree of folders, pages, uploaded files and meeting
// notes. It lives in the original `docs` table (so every old /docs?id=N link and doc id keeps
// working), extended with additive columns only. Nothing here hard-deletes on its own: "delete"
// means status='archived' (the Trash). The single hard delete, deletePageForever, is only ever
// reached from Owner pressing "Delete forever" on one item already in the Trash.
//
// Two representations of a page's content:
//  - content: the block editor's JSON (source of truth for anything edited in the UI)
//  - body:    markdown derived from it, which is what search, the agents and exports read.
// Agents write markdown; it's converted to blocks on the way in, so Owner's editor and the
// agents always see the same page.

export type PageKind = "page" | "folder" | "file" | "meeting";

export type Page = Doc & {
  parent_id: number | null;
  kind: PageKind;
  icon: string | null;
  content: string | null;
  tags: string; // JSON array
  summary: string | null;
  status: "active" | "archived";
  favorite: 0 | 1;
  sort_order: number;
  file_path: string | null;
  mime_type: string | null;
  file_size: number | null;
  placed_by: "owner" | "ai" | null; // who decided where it lives; set => the organizer won't move it
  enriched_hash: string | null;
  archived_at: string | null;
  share_token: string | null;
  shared_at: string | null;
  link: string | null;
};

const PAGE_COLUMNS: [string, string][] = [
  ["parent_id", "parent_id INTEGER"],
  ["kind", "kind TEXT NOT NULL DEFAULT 'page'"],
  ["icon", "icon TEXT"],
  ["content", "content TEXT"],
  ["tags", "tags TEXT NOT NULL DEFAULT '[]'"],
  ["summary", "summary TEXT"],
  ["status", "status TEXT NOT NULL DEFAULT 'active'"],
  ["favorite", "favorite INTEGER NOT NULL DEFAULT 0"],
  ["sort_order", "sort_order REAL NOT NULL DEFAULT 0"],
  ["file_path", "file_path TEXT"],
  ["mime_type", "mime_type TEXT"],
  ["file_size", "file_size INTEGER"],
  ["placed_by", "placed_by TEXT"],
  ["enriched_hash", "enriched_hash TEXT"],
  ["archived_at", "archived_at TEXT"],
  ["share_token", "share_token TEXT"],
  ["shared_at", "shared_at TEXT"],
  ["link", "link TEXT"],
];

export function normalizeLink(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (s.length > 2000 || !/^https?:\/\/\S+$/i.test(s)) throw new Error("Link must be a single http(s) URL");
  return s;
}

// ---------------------------------------------------------------- migration (additive only)
{
  const have = new Set((db.prepare(`PRAGMA table_info(docs)`).all() as { name: string }[]).map((c) => c.name));
  const missing = PAGE_COLUMNS.filter(([name]) => !have.has(name));
  const hasFts = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name='docs_fts'`).get();
  if (missing.length || !hasFts) {
    // Schema change on the live database: snapshot it first (VACUUM INTO is synchronous and
    // gives a consistent copy), separate from the nightly backups so pruning never touches it.
    const dir = path.join(DATA_DIR, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `pre-files-migration-${Date.now()}.db`);
    db.prepare(`VACUUM INTO ?`).run(dest);
    for (const [, ddl] of missing) db.exec(`ALTER TABLE docs ADD COLUMN ${ddl}`);
  }
  // Idempotent JD-link backfill: only fills empty links, each id guarded by a title match.
  const JD_LINK_BACKFILL: [number, string, string][] = [
    [425, "%MagicSchool%", "https://jobs.ashbyhq.com/magicschool/8ddc6d9c-f8f5-44a5-9aaa-dbd00bcfb504"],
    [423, "%GC AI%", "https://jobs.ashbyhq.com/gc-ai/0a022951-d8af-40cd-9747-d8f54f40d897"],
    [427, "%ElevenLabs%", "https://jobs.ashbyhq.com/elevenlabs/275f43d0-b62d-401d-830c-7c1ac0e688aa"],
    [429, "%Writer%", "https://jobs.ashbyhq.com/writer/df56ef1b-4d8b-4eda-bc03-ce9db800e533"],
    [431, "%FieldGuide%", "https://jobs.ashbyhq.com/fieldguide/4c43f78d-3dd0-4779-b872-dff4498345ce"],
    [433, "%Netomi%", "https://jobs.lever.co/netomi/644c8c03-2c34-4cc8-9148-b128aabbb4b5"],
    [435, "%Vantage%", "https://jobs.ashbyhq.com/vantage/2e27e8bd-4906-441a-9486-0ce7e053b2e7"],
    [437, "%HiddenLayer%", "https://job-boards.greenhouse.io/hiddenlayer/jobs/5141513007"],
    [439, "%Webflow%", "https://jobs.ashbyhq.com/webflow/211970a8-6193-4a7f-a960-315bbba556be"],
    [441, "%Tines%", "https://job-boards.greenhouse.io/tines/jobs/6100569004"],
    [368, "%Cresta%", "https://job-boards.greenhouse.io/cresta/jobs/5078921008"],
  ];
  const bf = db.prepare(`UPDATE docs SET link = ? WHERE id = ? AND link IS NULL AND title LIKE ?`);
  for (const [id, like, url] of JD_LINK_BACKFILL) bf.run(url, id, like);
  db.exec(`
    CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS docs_share_token ON docs(share_token) WHERE share_token IS NOT NULL;
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      title, body, tags, summary, content='docs', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS docs_fts_ai AFTER INSERT ON docs BEGIN
      INSERT INTO docs_fts(rowid, title, body, tags, summary) VALUES (new.id, new.title, new.body, new.tags, new.summary);
    END;
    CREATE TRIGGER IF NOT EXISTS docs_fts_ad AFTER DELETE ON docs BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, title, body, tags, summary) VALUES ('delete', old.id, old.title, old.body, old.tags, old.summary);
    END;
    CREATE TRIGGER IF NOT EXISTS docs_fts_au AFTER UPDATE OF title, body, tags, summary ON docs BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, title, body, tags, summary) VALUES ('delete', old.id, old.title, old.body, old.tags, old.summary);
      INSERT INTO docs_fts(rowid, title, body, tags, summary) VALUES (new.id, new.title, new.body, new.tags, new.summary);
    END;
  `);
  if (!hasFts) db.exec(`INSERT INTO docs_fts(docs_fts) VALUES ('rebuild')`);
}

const FILES_DIR = path.join(DATA_DIR, "files");

// ---------------------------------------------------------------- reads

export function getPage(id: number): Page | undefined {
  return db.prepare(`SELECT * FROM docs WHERE id = ?`).get(id) as Page | undefined;
}

// ---------------------------------------------------------------- public share links
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

/** Turn on the public read-only link for an active page. Idempotent: returns the existing token. */
export function enableShare(id: number): string {
  const p = getPage(id);
  if (!p) throw new Error("page not found");
  if (p.status !== "active" || p.kind !== "page") throw new Error("Only active pages can be shared");
  if (p.share_token) return p.share_token;
  const token = crypto.randomBytes(24).toString("base64url");
  db.prepare(`UPDATE docs SET share_token = ?, shared_at = datetime('now') WHERE id = ?`).run(token, id);
  return token;
}

/** Revoke the link. The page and its content are untouched; a later enable issues a new token. */
export function disableShare(id: number): void {
  db.prepare(`UPDATE docs SET share_token = NULL, shared_at = NULL WHERE id = ?`).run(id);
}

export function getSharedPage(token: string): Page | undefined {
  if (!SHARE_TOKEN_RE.test(token)) return undefined;
  return db.prepare(`SELECT * FROM docs WHERE share_token = ? AND status = 'active' AND kind = 'page'`).get(token) as Page | undefined;
}

export function pageTags(p: Pick<Page, "tags">): string[] {
  try {
    const t = JSON.parse(p.tags || "[]");
    return Array.isArray(t) ? t.map(String) : [];
  } catch {
    return [];
  }
}

export const pageUrl = (id: number) => `/files?id=${id}`;

/** Ancestors, root first (not including the page itself). */
export function breadcrumb(id: number): { id: number; title: string; icon: string | null }[] {
  const out: { id: number; title: string; icon: string | null }[] = [];
  const seen = new Set<number>();
  let cur = getPage(id)?.parent_id ?? null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const p = getPage(cur);
    if (!p) break;
    out.unshift({ id: p.id, title: p.title, icon: p.icon });
    cur = p.parent_id;
  }
  return out;
}

export const pathString = (id: number) => {
  const p = getPage(id);
  return [...breadcrumb(id).map((b) => b.title), p?.title ?? ""].join(" / ");
};

export type TreeNode = Pick<
  Page,
  "id" | "title" | "kind" | "icon" | "parent_id" | "favorite" | "sort_order" | "updated_at" | "created_by" | "mime_type" | "placed_by"
>;

/** Every active item (no bodies), for the sidebar tree. */
export function listTree(): TreeNode[] {
  return db
    .prepare(
      `SELECT id, title, kind, icon, parent_id, favorite, sort_order, updated_at, created_by, mime_type, placed_by
       FROM docs WHERE status = 'active' ORDER BY sort_order ASC, (kind = 'folder') DESC, title COLLATE NOCASE ASC`
    )
    .all() as TreeNode[];
}

export function listChildren(parentId: number | null) {
  return db
    .prepare(
      `SELECT id, title, kind, icon, parent_id, tags, summary, favorite, updated_at, created_by, mime_type, file_size
       FROM docs WHERE status = 'active' AND parent_id IS ?
       ORDER BY sort_order ASC, (kind = 'folder') DESC, title COLLATE NOCASE ASC`
    )
    .all(parentId) as Page[];
}

/** What was put in the Trash (its top-level items; things inside a trashed folder go with it). */
export function listTrash() {
  const rows = db
    .prepare(
      `SELECT d.id, d.title, d.kind, d.icon, d.parent_id, d.archived_at, d.updated_at
       FROM docs d LEFT JOIN docs p ON p.id = d.parent_id
       WHERE d.status = 'archived' AND (p.id IS NULL OR p.status != 'archived')
       ORDER BY d.archived_at DESC`
    )
    .all() as Page[];
  return rows.map((r) => ({ ...r, inside: descendantIds(r.id).length }));
}

export function listRecent(limit = 20) {
  return db
    .prepare(`SELECT id, title, kind, icon, parent_id, updated_at, created_by, mime_type FROM docs WHERE status='active' AND kind != 'folder' ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as Page[];
}

export type SearchHit = {
  id: number;
  title: string;
  kind: PageKind;
  icon: string | null;
  path: string;
  tags: string[];
  summary: string | null;
  snippet: string;
  updated_at: string;
  url: string;
};

/** FTS5 query from free text: every word must match (prefix match on the last one, so
 *  search-as-you-type works). Quotes each term, so user input can't inject FTS syntax. */
function ftsQuery(q: string): string | null {
  const terms = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 12);
  if (!terms.length) return null;
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
}

/** Ranked full-text search over titles, bodies, tags and AI summaries; titles weigh most. */
export function searchPages(q: string, opts: { limit?: number; includeArchived?: boolean; kind?: PageKind } = {}): SearchHit[] {
  const match = ftsQuery(q);
  if (!match) return [];
  const rows = db
    .prepare(
      `SELECT d.id, d.title, d.kind, d.icon, d.tags, d.summary, d.updated_at,
              snippet(docs_fts, 1, '«', '»', '…', 18) AS snippet
       FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
       WHERE docs_fts MATCH ? ${opts.includeArchived ? "" : "AND d.status = 'active'"} ${opts.kind ? "AND d.kind = ?" : ""}
       ORDER BY bm25(docs_fts, 10.0, 1.0, 4.0, 3.0)
       LIMIT ?`
    )
    .all(...([match, ...(opts.kind ? [opts.kind] : []), opts.limit ?? 20] as unknown[])) as (Page & { snippet: string })[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    icon: r.icon,
    path: pathString(r.id),
    tags: pageTags(r),
    summary: r.summary,
    snippet: r.snippet,
    updated_at: r.updated_at,
    url: pageUrl(r.id),
  }));
}

// ---------------------------------------------------------------- writes

function assertParent(parentId: number | null | undefined, selfId?: number) {
  if (parentId == null) return;
  const parent = getPage(parentId);
  if (!parent) throw new Error(`Parent ${parentId} not found`);
  if (parent.kind === "file") throw new Error("A file can't contain other items");
  if (selfId != null) {
    if (parentId === selfId) throw new Error("Can't put an item inside itself");
    if (breadcrumb(parentId).some((b) => b.id === selfId)) throw new Error("Can't move an item inside one of its own sub-pages");
  }
}

function nextSortOrder(parentId: number | null): number {
  const r = db.prepare(`SELECT MAX(sort_order) m FROM docs WHERE parent_id IS ?`).get(parentId) as { m: number | null };
  return (r.m ?? 0) + 1;
}

/** Folder by path ("Clients/Acme"), creating any missing folders along the way. */
export function ensureFolderPath(folderPath: string, createdBy: "owner" | "agent" = "agent"): number | null {
  const parts = folderPath
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  let parent: number | null = null;
  for (const name of parts) {
    const existing = db
      .prepare(`SELECT id FROM docs WHERE status='active' AND kind IN ('folder','page') AND parent_id IS ? AND title = ? COLLATE NOCASE`)
      .get(parent, name) as { id: number } | undefined;
    parent = existing ? existing.id : insertPage({ title: name, kind: "folder", parent_id: parent, created_by: createdBy, placed_by: createdBy === "owner" ? "owner" : "ai" }, "", null).id;
  }
  return parent;
}

type NewPage = {
  title: string;
  kind?: PageKind;
  parent_id?: number | null;
  body?: string; // markdown
  content?: unknown[] | null; // editor blocks
  icon?: string | null;
  tags?: string[];
  category?: string;
  created_by?: "owner" | "agent";
  placed_by?: "owner" | "ai" | null;
  file_path?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
  summary?: string | null;
  link?: string | null;
};

export async function createPage(input: NewPage): Promise<Page> {
  assertParent(input.parent_id ?? null);
  let content: string | null = null;
  let body = input.body ?? "";
  if (input.content && Array.isArray(input.content)) {
    content = JSON.stringify(input.content);
    body = await blocksToMarkdown(input.content);
  } else if (body) {
    content = JSON.stringify(await markdownToBlocks(body));
  }
  return insertPage(input, body, content);
}

function insertPage(input: NewPage, body: string, content: string | null): Page {
  const parent = input.parent_id ?? null;
  assertParent(parent);
  const r = db
    .prepare(
      `INSERT INTO docs (title, body, category, created_by, parent_id, kind, icon, content, tags, summary, sort_order, file_path, mime_type, file_size, placed_by, link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.title.trim() || "Untitled",
      body,
      input.category || "general",
      input.created_by || "owner",
      parent,
      input.kind || "page",
      input.icon ?? null,
      content,
      JSON.stringify(input.tags ?? []),
      input.summary ?? null,
      nextSortOrder(parent),
      input.file_path ?? null,
      input.mime_type ?? null,
      input.file_size ?? null,
      input.placed_by !== undefined ? input.placed_by : parent != null ? (input.created_by === "agent" ? "ai" : "owner") : null,
      normalizeLink(input.link)
    );
  return getPage(Number(r.lastInsertRowid))!;
}

export async function updatePage(
  id: number,
  changes: {
    title?: string;
    body?: string; // markdown (agents)
    append?: boolean;
    edits?: PageEdit[];
    content?: unknown[]; // editor blocks (UI)
    icon?: string | null;
    tags?: string[];
    summary?: string | null;
    category?: string;
    favorite?: boolean;
    link?: string | null;
  },
  opts: UpdateOpts = {}
): Promise<Page> {
  const explicitBase = opts.base_updated_at != null;
  for (let attempt = 0; ; attempt++) {
    try {
      return await updatePageOnce(id, changes, opts);
    } catch (e) {
      // Appends read-then-write; if something else saved in between, re-read and try again.
      if (e instanceof PageConflictError && !explicitBase && attempt < 3) continue;
      throw e;
    }
  }
}

export type UpdateOpts = {
  source?: "agent" | "ui" | "organize" | "undo";
  agent_slug?: string | null;
  /** Agent-only: allow a whole-body replace that the guard would otherwise reject. */
  allow_replace?: boolean;
  /** Optimistic concurrency: the page's updated_at the caller last saw. */
  base_updated_at?: string | null;
};

export class PageConflictError extends Error {
  constructor() {
    super("Page changed since it was loaded");
    this.name = "PageConflictError";
  }
}

const VERSIONS_KEPT = 50;
const UI_VERSION_GAP_MINUTES = 5;

function snapshotVersion(page: Page, source: NonNullable<UpdateOpts["source"]>, agentSlug: string | null) {
  if (source === "ui") {
    const recent = db
      .prepare(
        `SELECT 1 FROM page_versions WHERE page_id = ? AND source = 'ui' AND created_at > datetime('now', ?) LIMIT 1`
      )
      .get(page.id, `-${UI_VERSION_GAP_MINUTES} minutes`);
    if (recent) return;
  }
  db.prepare(`INSERT INTO page_versions (page_id, title, body, content, source, agent_slug) VALUES (?, ?, ?, ?, ?, ?)`).run(
    page.id,
    page.title,
    page.body,
    page.content,
    source,
    agentSlug
  );
  // Keep the newest 50; only older history rows are pruned, never the live page.
  db.prepare(
    `DELETE FROM page_versions WHERE page_id = ? AND id NOT IN (SELECT id FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT ?)`
  ).run(page.id, page.id, VERSIONS_KEPT);
}

function guardAgentReplace(page: Page, newBody: string) {
  const old = page.body || "";
  if (!old.trim()) return;
  const last = db
    .prepare(`SELECT MAX(created_at) AS t FROM page_versions WHERE page_id = ? AND source = 'agent'`)
    .get(page.id) as { t: string | null };
  const ownerLast = page.created_by === "agent" ? !!last.t && page.updated_at > last.t : !last.t || page.updated_at > last.t;
  const hint = "Use append:true or targeted edits, or ask Owner (allow_replace is only for when he explicitly asked).";
  if (old.length > 200 && ownerLast) {
    throw new Error(`Refused: this page has content Owner wrote or edited last, and a whole-body replace would overwrite it. ${hint}`);
  }
  if (newBody.length < old.length * 0.5) {
    throw new Error(`Refused: the new body is under half the length of the existing page, which looks like blanking it. ${hint}`);
  }
}

async function updatePageOnce(
  id: number,
  changes: Parameters<typeof updatePage>[1],
  opts: UpdateOpts
): Promise<Page> {
  const page = getPage(id);
  if (!page) throw new Error("Page not found");
  if (opts.base_updated_at != null && opts.base_updated_at !== page.updated_at) throw new PageConflictError();
  const source = opts.source ?? "ui";
  if (source === "agent" && changes.body !== undefined && !changes.append && !changes.edits?.length && !opts.allow_replace) {
    guardAgentReplace(page, changes.body);
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (changes.title !== undefined) set("title", changes.title.trim() || "Untitled");
  if (changes.category !== undefined) set("category", changes.category);
  if (changes.icon !== undefined) set("icon", changes.icon);
  if (changes.tags !== undefined) set("tags", JSON.stringify(changes.tags.map((t) => t.trim()).filter(Boolean)));
  if (changes.summary !== undefined) set("summary", changes.summary);
  if (changes.favorite !== undefined) set("favorite", changes.favorite ? 1 : 0);
  if (changes.link !== undefined) set("link", normalizeLink(changes.link));

  if (changes.content !== undefined) {
    set("content", JSON.stringify(changes.content));
    set("body", await blocksToMarkdown(changes.content));
  } else if (changes.edits && changes.edits.length) {
    if (changes.body !== undefined) throw new Error("Use either body or edits, not both");
    const base = page.body || (await blocksToMarkdown(await currentBlocks(page)));
    const next = applyPageEdits(base, changes.edits);
    set("content", JSON.stringify(await markdownToBlocks(next)));
    set("body", next);
  } else if (changes.body !== undefined) {
    if (changes.append) {
      const existing = await currentBlocks(page);
      const added = await markdownToBlocks(changes.body);
      const blocks = [...existing, ...added];
      set("content", JSON.stringify(blocks));
      set("body", await blocksToMarkdown(blocks));
    } else {
      set("content", JSON.stringify(await markdownToBlocks(changes.body)));
      set("body", changes.body);
    }
  }
  if (!sets.length) return page;
  const contentChanged = changes.content !== undefined || changes.body !== undefined || changes.title !== undefined || !!changes.edits?.length;
  const bodyChanged = sets.some((s) => s.startsWith("content =") || s.startsWith("body ="));
  // Synchronous transaction: re-check the page is unchanged, snapshot it, then write.
  db.transaction(() => {
    const cur = db.prepare(`SELECT updated_at FROM docs WHERE id = ?`).get(id) as { updated_at: string } | undefined;
    if (!cur || cur.updated_at !== page.updated_at) throw new PageConflictError();
    if (bodyChanged) snapshotVersion(page, source, opts.agent_slug ?? null);
    db.prepare(`UPDATE docs SET ${sets.join(", ")}${contentChanged ? ", updated_at = datetime('now')" : ""} WHERE id = ?`).run(...vals, id);
  })();
  return getPage(id)!;
}

/** The page's blocks, converting legacy markdown-only docs on the fly. */
export async function currentBlocks(page: Page): Promise<unknown[]> {
  if (page.content) {
    try {
      const parsed = JSON.parse(page.content);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }
  return page.body ? markdownToBlocks(page.body) : [];
}

export function movePage(id: number, parentId: number | null, placedBy: "owner" | "ai", beforeId?: number | null): Page {
  const page = getPage(id);
  if (!page) throw new Error("Page not found");
  assertParent(parentId, id);
  let order = nextSortOrder(parentId);
  if (beforeId) {
    const before = getPage(beforeId);
    if (before && before.parent_id === parentId) {
      const prev = db
        .prepare(`SELECT MAX(sort_order) m FROM docs WHERE parent_id IS ? AND sort_order < ? AND id != ?`)
        .get(parentId, before.sort_order, id) as { m: number | null };
      order = ((prev.m ?? before.sort_order - 1) + before.sort_order) / 2;
    }
  }
  db.prepare(`UPDATE docs SET parent_id = ?, sort_order = ?, placed_by = ? WHERE id = ?`).run(parentId, order, placedBy, id);
  return getPage(id)!;
}

/** Soft delete: the item and everything under it go to the Trash (restorable). */
export function archivePage(id: number): { archived: number[] } {
  const ids = [id, ...descendantIds(id)];
  const stmt = db.prepare(`UPDATE docs SET status='archived', archived_at=datetime('now') WHERE id = ? AND status='active'`);
  db.transaction(() => ids.forEach((i) => stmt.run(i)))();
  return { archived: ids };
}

export function restorePage(id: number): Page {
  const page = getPage(id);
  if (!page) throw new Error("Page not found");
  const ids = [id, ...descendantIds(id)];
  // Restore under its old parent if that's still around, else at the top level.
  const parent = page.parent_id ? getPage(page.parent_id) : undefined;
  db.transaction(() => {
    const stmt = db.prepare(`UPDATE docs SET status='active', archived_at=NULL WHERE id = ?`);
    ids.forEach((i) => stmt.run(i));
    if (page.parent_id && (!parent || parent.status !== "active")) db.prepare(`UPDATE docs SET parent_id=NULL WHERE id=?`).run(id);
  })();
  return getPage(id)!;
}

/** Permanent delete of ONE item Owner picked in the Trash ("Delete forever"), together with what
 *  was inside it when it was trashed. Refuses unless the item and everything under it are
 *  already in the Trash, so nothing active can ever be reached from here. */
export function deletePageForever(id: number): { deleted: number } {
  const page = getPage(id);
  if (!page) return { deleted: 0 };
  if (page.status !== "archived") throw new Error("Move it to the Trash first");
  const ids = [...descendantIds(id).reverse(), id]; // children before parents
  const rows = ids.map((i) => getPage(i)!);
  if (rows.some((r) => r.status !== "archived")) throw new Error("Something inside it is still in use; move it out first");
  const del = db.prepare(`DELETE FROM docs WHERE id = ? AND status = 'archived'`);
  let deleted = 0;
  db.transaction(() => rows.forEach((r) => (deleted += del.run(r.id).changes)))();
  for (const r of rows) {
    if (!r.file_path) continue;
    const p = path.join(FILES_DIR, path.basename(r.file_path));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return { deleted };
}

function descendantIds(id: number): number[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (SELECT id FROM docs WHERE parent_id = ? UNION ALL SELECT d.id FROM docs d JOIN sub ON d.parent_id = sub.id)
       SELECT id FROM sub`
    )
    .all(id) as { id: number }[];
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------- uploaded files

export function filesDir() {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  return FILES_DIR;
}

export function absoluteFilePath(page: Pick<Page, "file_path">): string | null {
  return page.file_path ? path.join(FILES_DIR, path.basename(page.file_path)) : null;
}

/** For agents and search: a compact outline of the whole workspace ("Folder/Sub/Page"). */
export function outline(maxItems = 400): string {
  const nodes = listTree();
  const byParent = new Map<number | null, TreeNode[]>();
  for (const n of nodes) {
    const k = n.parent_id ?? null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(n);
  }
  const lines: string[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const n of byParent.get(parent) || []) {
      if (lines.length >= maxItems) return;
      lines.push(`${"  ".repeat(depth)}- [${n.kind}] ${n.title} (#${n.id})`);
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n") || "(empty)";
}
