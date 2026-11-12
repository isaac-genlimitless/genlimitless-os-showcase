import Database from "better-sqlite3";
import path from "path";
import { appleDate, decodeAttributedBody, displayName, loadContacts, messagesDb, type IMessage, type Contact } from "./imessage";

// Full-text index of Owner's Apple Messages, so searching takes milliseconds.
//
// Why: macOS stores most message text in a binary blob that has to be decoded one message at a
// time, so the old search decoded ~20,000 messages in JS per keystroke (4-6 s, blocking the
// whole server). This decodes each message once, in the background, into a local SQLite FTS5
// table, then only indexes new messages as they arrive.
//
// It's a disposable cache in its own file (data/msg-index.db, gitignored, unreadable by the
// agents): delete the file and it rebuilds itself. Read-only against chat.db.

import { DATA_DIR } from "./data-dir";
const IDX_PATH = path.join(DATA_DIR, "msg-index.db");
const BATCH = 4000;

let idx: Database.Database | null = null;
function index() {
  if (!idx) {
    idx = new Database(IDX_PATH);
    idx.pragma("journal_mode = WAL");
    idx.exec(`
      CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
        text,
        msg_rowid UNINDEXED, chat_id UNINDEXED, from_me UNINDEXED, date UNINDEXED, handle UNINDEXED, service UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  }
  return idx;
}

function watermark(): number {
  const r = index().prepare(`SELECT v FROM state WHERE k='watermark'`).get() as { v: string } | undefined;
  return r ? Number(r.v) : 0;
}

/** Index one batch of new messages. Returns true if there may be more to do. */
function indexBatch(): boolean {
  const wm = watermark();
  const rows = messagesDb()
    .prepare(
      `SELECT m.ROWID as id, cmj.chat_id, m.text, m.attributedBody, m.is_from_me, h.id as handle, m.date, m.service
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       WHERE m.ROWID > ? AND m.associated_message_type = 0
       ORDER BY m.ROWID LIMIT ?`
    )
    .all(wm, BATCH) as {
    id: number;
    chat_id: number;
    text: string | null;
    attributedBody: Buffer | null;
    is_from_me: number;
    handle: string | null;
    date: number;
    service: string | null;
  }[];
  if (rows.length === 0) return false;

  const db = index();
  const insert = db.prepare(`INSERT INTO fts (text, msg_rowid, chat_id, from_me, date, handle, service) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const r of rows) {
      const text = (r.text ?? decodeAttributedBody(r.attributedBody) ?? "").replace(/￼/g, "").trim();
      if (text) insert.run(text, r.id, r.chat_id, r.is_from_me, r.date, r.handle, r.service || "iMessage");
    }
    db.prepare(`INSERT INTO state (k, v) VALUES ('watermark', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(String(rows[rows.length - 1].id));
  })();
  return rows.length === BATCH;
}

let running = false;
/** Catch the index up to chat.db without hogging the server: one batch, then yield. */
export async function runIndexer(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (indexBatch()) await new Promise((r) => setImmediate(r));
  } catch {
    // No Full Disk Access (or Messages unavailable): search falls back to the slow path.
  } finally {
    running = false;
  }
}

/** True once the index has caught up (a few just-arrived messages of lag is fine). */
export function indexReady(): boolean {
  try {
    const max = (messagesDb().prepare(`SELECT MAX(ROWID) as m FROM message`).get() as { m: number }).m || 0;
    return watermark() >= max - 300 && watermark() > 0;
  } catch {
    return false;
  }
}

/** Fast search. Returns null while the index is still being built (caller falls back). */
export function searchIndexed(q: string, limit = 60): IMessage[] | null {
  if (!indexReady()) return null;
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_'-]/gu, ""))
    .filter(Boolean);
  if (terms.length === 0) return [];
  const match = terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
  const rows = index()
    .prepare(
      `SELECT msg_rowid, chat_id, text, from_me, date, handle, service FROM fts
       WHERE fts MATCH ? ORDER BY CAST(date AS INTEGER) DESC LIMIT ?`
    )
    .all(match, limit) as { msg_rowid: number; chat_id: number; text: string; from_me: number; date: number; handle: string | null; service: string }[];

  let byHandle = new Map<string, Contact>();
  try {
    byHandle = loadContacts().byHandle;
  } catch {
    // Contacts unavailable: fall back to raw handles.
  }
  return rows.map((r) => ({
    id: r.msg_rowid,
    chat_id: r.chat_id,
    text: r.text,
    from_me: !!r.from_me,
    sender: r.from_me ? "Me" : displayName(r.handle, byHandle),
    at: appleDate(r.date),
    service: r.service || "iMessage",
    has_attachment: false,
  }));
}
