import db from "./db";
import { createEscalation } from "./agents/registry";
import { getPage, type Page } from "./pages";

// Comments anchored to highlighted text on a page. Separate table; never touches docs.
// Nothing here deletes comments.

db.exec(`
  CREATE TABLE IF NOT EXISTS file_comments (
    id INTEGER PRIMARY KEY,
    page_id INTEGER NOT NULL,
    parent_id INTEGER,
    quote TEXT,
    prefix TEXT,
    suffix TEXT,
    start_off INTEGER,
    end_off INTEGER,
    body TEXT NOT NULL,
    author TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('owner','share')),
    resolved INTEGER NOT NULL DEFAULT 0,
    resolved_by TEXT,
    resolved_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS file_comments_page ON file_comments(page_id, id);
`);

export type FileComment = {
  id: number;
  page_id: number;
  parent_id: number | null;
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
  start_off: number | null;
  end_off: number | null;
  body: string;
  author: string;
  source: "owner" | "share";
  resolved: number;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
};

export const CAPS = { body: 2000, author: 60, quote: 1000, context: 80 };
export const MAX_COMMENTS_PER_PAGE = 1000;
export const MAX_SHARE_WRITES_PER_HOUR = 100;

export class CommentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Plain-text cleanup with no regex: drops control characters (keeps newline), normalises line endings, caps, trims. */
export function sanitizeText(input: unknown, max: number): string {
  if (typeof input !== "string") return "";
  const unified = input.split("\r\n").join("\n").split("\r").join("\n");
  let out = "";
  for (let i = 0; i < unified.length; i++) {
    const c = unified.charCodeAt(i);
    if (c < 32 && c !== 10) continue;
    if (c === 127) continue;
    out += unified[i];
  }
  return out.slice(0, max).trim();
}

function offset(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 10000000 ? v : null;
}

export function listComments(pageId: number): FileComment[] {
  return db.prepare(`SELECT * FROM file_comments WHERE page_id = ? ORDER BY id`).all(pageId) as FileComment[];
}

export function getComment(pageId: number, id: number): FileComment | undefined {
  return db.prepare(`SELECT * FROM file_comments WHERE id = ? AND page_id = ?`).get(id, pageId) as FileComment | undefined;
}

export type NewComment = {
  quote?: unknown;
  prefix?: unknown;
  suffix?: unknown;
  start?: unknown;
  end?: unknown;
  parent_id?: unknown;
  body?: unknown;
};

export function addComment(page: Page, input: NewComment, author: string, source: "owner" | "share"): FileComment {
  const body = sanitizeText(input.body, CAPS.body);
  if (!body) throw new CommentError("comment text required");
  const name = sanitizeText(author, CAPS.author);
  if (!name) throw new CommentError("name required");

  const total = db.prepare(`SELECT COUNT(*) AS n FROM file_comments WHERE page_id = ?`).get(page.id) as { n: number };
  if (total.n >= MAX_COMMENTS_PER_PAGE) throw new CommentError("this file has reached its comment limit", 429);
  if (source === "share") {
    const recent = db
      .prepare(`SELECT COUNT(*) AS n FROM file_comments WHERE source = 'share' AND created_at >= datetime('now', '-1 hour')`)
      .get() as { n: number };
    if (recent.n >= MAX_SHARE_WRITES_PER_HOUR) throw new CommentError("too many comments right now, try later", 429);
  }

  let parent: number | null = null;
  let quote: string | null = null;
  let prefix: string | null = null;
  let suffix: string | null = null;
  let start: number | null = null;
  let end: number | null = null;

  if (input.parent_id !== undefined && input.parent_id !== null) {
    const pid = Number(input.parent_id);
    const root = Number.isInteger(pid) ? getComment(page.id, pid) : undefined;
    if (!root || root.parent_id !== null) throw new CommentError("parent comment not found", 404);
    parent = root.id;
    quote = root.quote;
    prefix = root.prefix;
    suffix = root.suffix;
    start = root.start_off;
    end = root.end_off;
  } else {
    quote = sanitizeText(input.quote, CAPS.quote) || null;
    prefix = sanitizeText(input.prefix, CAPS.context) || null;
    suffix = sanitizeText(input.suffix, CAPS.context) || null;
    start = offset(input.start);
    end = offset(input.end);
  }

  const r = db
    .prepare(
      `INSERT INTO file_comments (page_id, parent_id, quote, prefix, suffix, start_off, end_off, body, author, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(page.id, parent, quote, prefix, suffix, start, end, body, name, source);
  return db.prepare(`SELECT * FROM file_comments WHERE id = ?`).get(Number(r.lastInsertRowid)) as FileComment;
}

export function setResolved(pageId: number, id: number, resolved: boolean, by: string): FileComment {
  const c = getComment(pageId, id);
  if (!c) throw new CommentError("comment not found", 404);
  const who = sanitizeText(by, CAPS.author) || "Guest";
  if (resolved) {
    db.prepare(`UPDATE file_comments SET resolved = 1, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`).run(who, id);
  } else {
    db.prepare(`UPDATE file_comments SET resolved = 0, resolved_by = NULL, resolved_at = NULL WHERE id = ?`).run(id);
  }
  return getComment(pageId, id) as FileComment;
}

/** Only the fields a viewer needs. */
export function publicComment(c: FileComment) {
  return {
    id: c.id,
    parent_id: c.parent_id,
    quote: c.quote,
    prefix: c.prefix,
    suffix: c.suffix,
    start: c.start_off,
    end: c.end_off,
    body: c.body,
    author: c.author,
    source: c.source,
    resolved: !!c.resolved,
    resolved_by: c.resolved_by,
    resolved_at: c.resolved_at,
    created_at: c.created_at,
  };
}

// ---------------------------------------------------------------- abuse limits (in memory)
const hits = new Map<string, number[]>();
const PER_MINUTE = 6;
const PER_HOUR = 40;

/** Returns 0 if allowed (and records the hit), else seconds to wait. */
export function rateLimit(key: string, now = Date.now()): number {
  const list = (hits.get(key) || []).filter((t) => now - t < 3600000);
  const minute = list.filter((t) => now - t < 60000);
  if (minute.length >= PER_MINUTE) {
    hits.set(key, list);
    return Math.max(1, Math.ceil((minute[0] + 60000 - now) / 1000));
  }
  if (list.length >= PER_HOUR) {
    hits.set(key, list);
    return Math.max(1, Math.ceil((list[0] + 3600000 - now) / 1000));
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 3600000) hits.delete(k);
  }
  return 0;
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0].trim();
  return first || req.headers.get("x-real-ip") || "unknown";
}

/** POST needs Origin host == Host, or no Origin and Sec-Fetch-Site not cross-site. */
export function originOk(req: Request): boolean {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return req.headers.get("sec-fetch-site") !== "cross-site";
}

/** In-app notice only (an FYI escalation); sends nothing outward. Coalesces into the open item for the same page. */
export function notifyOwner(page: Pick<Page, "id" | "title">, c: Pick<FileComment, "author" | "body">) {
  const title = `New comments on shared file: ${page.title}`;
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const line = `${c.author}: ${c.body.slice(0, 200)} (${hh}:${mm})`;
  const open = db
    .prepare(`SELECT id, detail FROM escalations WHERE status='open' AND from_agent='files-comments' AND title=?`)
    .get(title) as { id: number; detail: string | null } | undefined;
  if (open) {
    const lines = (open.detail || "").split("\n").filter((l) => l.length > 0);
    lines.push(line);
    const kept = lines.slice(-20);
    db.prepare(`UPDATE escalations SET detail = ? WHERE id = ?`).run(kept.join("\n"), open.id);
    return;
  }
  createEscalation({ from_agent: "files-comments", severity: "fyi", kind: "message", title, detail: line });
}

export function pageForComments(id: number): { page?: Page; status?: number; error?: string } {
  const page = Number.isInteger(id) ? getPage(id) : undefined;
  if (!page) return { status: 404, error: "not found" };
  if (page.kind !== "page") return { status: 400, error: "Only pages can have comments" };
  return { page };
}
