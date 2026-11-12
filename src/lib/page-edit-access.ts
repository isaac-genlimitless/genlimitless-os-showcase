import crypto from "crypto";
import fs from "fs";
import path from "path";
import db from "./db";
import { DATA_DIR } from "./data-dir";
import { getPage, updatePage, currentBlocks, PageConflictError, type Page } from "./pages";
import { blocksToMarkdown, markdownToBlocks } from "./blocks";

// Per-page "allow editing" link, separate from the read-only share link. The edit token is stored
// only as a sha256 hash. Editors can change the page BODY only, through targeted splices, and every
// save is logged with the previous state. Nothing in this file deletes rows from any table.

{
  const have = (n: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(n);
  if (!have("page_edit_access") && !have("page_edit_log")) {
    try {
      const dir = path.join(DATA_DIR, "backups");
      fs.mkdirSync(dir, { recursive: true });
      db.prepare(`VACUUM INTO ?`).run(path.join(dir, `pre-edit-access-${Date.now()}.db`));
    } catch {
      /* backup is best effort; the migration below is additive only */
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS page_edit_access (
      page_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      token_hash TEXT,
      csrf_secret TEXT,
      bound_share_hash TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      rotated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS page_edit_access_token ON page_edit_access(token_hash) WHERE token_hash IS NOT NULL;
    CREATE TABLE IF NOT EXISTS page_edit_log (
      id INTEGER PRIMARY KEY,
      page_id INTEGER NOT NULL,
      editor TEXT,
      ip_hash TEXT,
      prev_updated_at TEXT,
      new_updated_at TEXT,
      prev_title TEXT,
      prev_body TEXT,
      prev_content TEXT,
      removed_chars INTEGER NOT NULL DEFAULT 0,
      added_chars INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      restored_at TEXT
    );
    CREATE INDEX IF NOT EXISTS page_edit_log_page ON page_edit_log(page_id, id);
  `);
}

export type EditAccess = {
  page_id: number;
  enabled: number;
  token_hash: string | null;
  csrf_secret: string | null;
  bound_share_hash: string | null;
  expires_at: string | null;
  created_at: string | null;
  rotated_at: string | null;
};

export class EditError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(message: string, status = 400, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const LIMITS = {
  request: 64 * 1024,
  replacement: 20000,
  removeMin: 2000,
  removeFraction: 0.25,
  body: 150000,
  editsPer30Days: 500,
  editor: 60,
};

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function getAccess(pageId: number): EditAccess | undefined {
  return db.prepare(`SELECT * FROM page_edit_access WHERE page_id = ?`).get(pageId) as EditAccess | undefined;
}

function checkExpiry(expiresAt: string | null): string | null {
  if (expiresAt == null || expiresAt === "") return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) throw new EditError("Invalid expiry date");
  const now = Date.now();
  if (t <= now) throw new EditError("Expiry must be in the future");
  if (t > now + 365 * 86400000) throw new EditError("Expiry can be at most 365 days away");
  return new Date(t).toISOString();
}

function sharedPage(pageId: number): Page {
  const p = getPage(pageId);
  if (!p || p.kind !== "page" || p.status !== "active") throw new EditError("Only active pages can be edited", 400);
  if (!p.share_token) throw new EditError("Turn on view-only sharing first", 400);
  return p;
}

function issue(pageId: number, expiresAt: string | null): string {
  const p = sharedPage(pageId);
  const exp = checkExpiry(expiresAt);
  const token = crypto.randomBytes(24).toString("base64url");
  db.prepare(
    `INSERT INTO page_edit_access (page_id, enabled, token_hash, csrf_secret, bound_share_hash, expires_at, rotated_at)
     VALUES (?, 1, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(page_id) DO UPDATE SET enabled = 1, token_hash = excluded.token_hash, csrf_secret = excluded.csrf_secret,
       bound_share_hash = excluded.bound_share_hash, expires_at = excluded.expires_at, rotated_at = datetime('now')`
  ).run(pageId, sha(token), crypto.randomBytes(32).toString("hex"), sha(p.share_token as string), exp);
  return token;
}

/** Returns the raw token ONCE; only its hash is stored. */
export function enableEdit(pageId: number, expiresAt: string | null = null): string {
  return issue(pageId, expiresAt);
}

/** New token and csrf secret: every old edit link dies at once. */
export function regenerateEdit(pageId: number): string {
  const cur = getAccess(pageId);
  return issue(pageId, cur?.expires_at ?? null);
}

export function disableEdit(pageId: number): void {
  db.prepare(`UPDATE page_edit_access SET enabled = 0, token_hash = NULL WHERE page_id = ?`).run(pageId);
}

export function setExpiry(pageId: number, iso: string | null): void {
  const exp = checkExpiry(iso);
  if (!getAccess(pageId)) throw new EditError("Editing has not been turned on", 400);
  db.prepare(`UPDATE page_edit_access SET expires_at = ? WHERE page_id = ?`).run(exp, pageId);
}

/** The single gate for every editor request. Any failure is null (the caller answers with one 404). */
export function resolveEdit(token: string): { page: Page; access: EditAccess } | null {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const hash = sha(token);
  const access = db.prepare(`SELECT * FROM page_edit_access WHERE token_hash = ?`).get(hash) as EditAccess | undefined;
  if (!access || !access.token_hash) return null;
  const a = Buffer.from(access.token_hash);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (access.enabled !== 1) return null;
  if (access.expires_at) {
    const t = Date.parse(access.expires_at);
    if (!Number.isFinite(t) || t <= Date.now()) return null;
  }
  const page = getPage(access.page_id);
  if (!page || page.status !== "active" || page.kind !== "page" || !page.share_token) return null;
  if (!access.bound_share_hash || sha(page.share_token) !== access.bound_share_hash) return null;
  return { page, access };
}

/** True when the edit link would currently work (flag on, not expired, still bound to the current read share). */
export function editActive(page: Pick<Page, "share_token" | "status" | "kind">, access: EditAccess | undefined): boolean {
  if (!access || access.enabled !== 1 || !access.token_hash || !page.share_token) return false;
  if (page.status !== "active" || page.kind !== "page") return false;
  if (access.expires_at && !(Date.parse(access.expires_at) > Date.now())) return false;
  return !!access.bound_share_hash && sha(page.share_token) === access.bound_share_hash;
}

export function csrfFor(access: Pick<EditAccess, "csrf_secret" | "page_id">): string {
  return crypto.createHmac("sha256", access.csrf_secret || "").update(`edit:${access.page_id}`).digest("hex");
}

export function csrfOk(access: EditAccess, got: string | null): boolean {
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(csrfFor(access));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- sanitising editor text
const OK_SCHEME = /^(https?|mailto):/i;

function urlOk(raw: string): boolean {
  let u = "";
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    if (c <= 32 || c === 127) continue; // browsers ignore these inside schemes
    u += ch;
  }
  if (/&#|&colon;|&tab;|&newline;/i.test(u)) return false;
  return OK_SCHEME.test(u);
}

export function sanitizeEditText(input: unknown, max = LIMITS.replacement): string {
  if (typeof input !== "string") return "";
  const unified = input.split("\r\n").join("\n").split("\r").join("\n");
  let out = "";
  for (let i = 0; i < unified.length; i++) {
    const c = unified.charCodeAt(i);
    if (c < 32 && c !== 10 && c !== 9) continue;
    if (c === 127) continue;
    out += unified[i];
  }
  out = out.normalize("NFC").slice(0, max);
  // neutralise raw HTML: "<x", "</", "<!", "<?" become "\<"
  out = out.replace(/(\\?)<(?=[A-Za-z/!?])/g, (m, b: string) => (b ? m : "\\<"));
  // inline links and images; images become links, unsafe URLs become plain text
  out = out.replace(/!?\[([^\]\n]*)\]\(\s*<?([^)\s>]*)[^)\n]*\)/g, (_m, text: string, url: string) => (urlOk(url) ? `[${text}](${url})` : text));
  // reference-style definitions: [id]: url
  out = out.replace(/^([ \t]*)\[([^\]\n]+)\]:[ \t]*<?(\S*)>?.*$/gm, (_m, ws: string, label: string, url: string) =>
    urlOk(url) ? `${ws}[${label}]: ${url}` : `${ws}${label}`
  );
  // reference-style images ![alt][ref] become links
  out = out.replace(/!(\[[^\]\n]*\]\[[^\]\n]*\])/g, "$1");
  return out;
}

function cleanName(s: unknown): string {
  if (typeof s !== "string") return "Guest";
  let out = "";
  for (const ch of s.split("\r").join(" ").split("\n").join(" ")) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c === 127) continue;
    out += ch;
  }
  out = out.normalize("NFC").replace(/[<>]/g, "").trim().slice(0, LIMITS.editor).trim();
  return out || "Guest";
}

// ---------------------------------------------------------------- rate limits (in memory)
const hits = new Map<string, number[]>();
/** Returns 0 if allowed (and records the hit), else seconds to wait. */
export function editLimit(key: string, perMinute: number, perHour: number, now = Date.now()): number {
  const list = (hits.get(key) || []).filter((t) => now - t < 3600000);
  const minute = list.filter((t) => now - t < 60000);
  if (minute.length >= perMinute) {
    hits.set(key, list);
    return Math.max(1, Math.ceil((minute[0] + 60000 - now) / 1000));
  }
  if (list.length >= perHour) {
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
export const writeLimit = (access: EditAccess, ip: string) => editLimit(`w:${access.token_hash}:${ip}`, 20, 200);
export const readLimit = (access: EditAccess, ip: string) => editLimit(`r:${access.token_hash}:${ip}`, 60, 100000);
export const badTokenLimit = (ip: string) => editLimit(`bad:${ip}`, 30, 100000);

// ---------------------------------------------------------------- reading and writing
export async function currentMarkdown(page: Page): Promise<string> {
  if (page.body) return page.body;
  if (page.content) {
    try {
      return (await blocksToMarkdown(await currentBlocks(page))) || "";
    } catch {
      /* fall through */
    }
  }
  return "";
}

export function lastEdit(pageId: number): { editor: string; created_at: string } | null {
  const r = db.prepare(`SELECT editor, created_at FROM page_edit_log WHERE page_id = ? ORDER BY id DESC LIMIT 1`).get(pageId) as
    | { editor: string; created_at: string }
    | undefined;
  return r ? { editor: r.editor || "Guest", created_at: r.created_at } : null;
}

export type EditorChange = {
  base_updated_at: unknown;
  start: unknown;
  end: unknown;
  expected: unknown;
  replacement: unknown;
  editor?: unknown;
};

export async function applyEditorChange(token: string, change: EditorChange, ip = "unknown") {
  const r = resolveEdit(token);
  if (!r) throw new EditError("Not found", 404);
  const { page, access } = r;
  const { base_updated_at: base, start, end, expected, replacement } = change;
  if (typeof base !== "string" || !base) throw new EditError("base_updated_at required");
  if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end)) throw new EditError("start and end must be integers");
  if (typeof expected !== "string" || typeof replacement !== "string") throw new EditError("expected and replacement must be strings");
  if (replacement.length > LIMITS.replacement) throw new EditError(`Replacement is too long (max ${LIMITS.replacement} characters)`);

  const body = await currentMarkdown(page);
  const latest = () => ({ body, updated_at: page.updated_at });
  if (base !== page.updated_at) throw new EditError("This page changed since you loaded it", 409, latest());
  if (start < 0 || start > end || end > body.length) throw new EditError("Invalid range");
  if (body.slice(start, end) !== expected) throw new EditError("The text you changed is no longer there", 409, latest());

  const removed = end - start;
  if (removed > Math.max(LIMITS.removeMin, Math.floor(body.length * LIMITS.removeFraction))) {
    throw new EditError("That removes too much text in one save");
  }
  const clean = sanitizeEditText(replacement);
  const next = body.slice(0, start) + clean + body.slice(end);
  if (next.length > LIMITS.body) throw new EditError("The page would become too long");
  if (next === body) return { page, changed: false };

  const recent = db
    .prepare(`SELECT COUNT(*) AS n FROM page_edit_log WHERE page_id = ? AND created_at >= datetime('now', '-30 days')`)
    .get(page.id) as { n: number };
  if (recent.n >= LIMITS.editsPer30Days) throw new EditError("Too many edits on this page recently", 429);

  let updated: Page;
  try {
    updated = await updatePage(page.id, { body: next }, { source: "undo", base_updated_at: base });
  } catch (e) {
    if (e instanceof PageConflictError) throw new EditError("This page changed since you loaded it", 409, { body: getPage(page.id)?.body ?? "", updated_at: getPage(page.id)?.updated_at });
    throw e;
  }
  db.prepare(
    `INSERT INTO page_edit_log (page_id, editor, ip_hash, prev_updated_at, new_updated_at, prev_title, prev_body, prev_content, removed_chars, added_chars)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(page.id, cleanName(change.editor), sha(`${ip}|${access.token_hash}`), page.updated_at, updated.updated_at, page.title, page.body, page.content, removed, clean.length);
  return { page: updated, changed: true };
}

export function listEdits(pageId: number, limit = 50) {
  return db
    .prepare(
      `SELECT id, editor, created_at, removed_chars, added_chars, restored_at FROM page_edit_log WHERE page_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(pageId, limit) as { id: number; editor: string; created_at: string; removed_chars: number; added_chars: number; restored_at: string | null }[];
}

/** Put back the state from before a logged edit. The current state is snapshotted first, so this is undoable. */
export async function restoreEdit(pageId: number, logId: number): Promise<Page> {
  const row = db.prepare(`SELECT * FROM page_edit_log WHERE id = ? AND page_id = ?`).get(logId, pageId) as
    | { prev_body: string | null; prev_content: string | null }
    | undefined;
  if (!row) throw new EditError("Edit not found", 404);
  let blocks: unknown[] | null = null;
  if (row.prev_content) {
    try {
      const parsed = JSON.parse(row.prev_content);
      if (Array.isArray(parsed)) blocks = parsed;
    } catch {
      /* fall back to the body */
    }
  }
  if (!blocks) blocks = await markdownToBlocks(row.prev_body || "");
  const page = await updatePage(pageId, { content: blocks }, { source: "undo" });
  db.prepare(`UPDATE page_edit_log SET restored_at = datetime('now') WHERE id = ?`).run(logId);
  return page;
}
