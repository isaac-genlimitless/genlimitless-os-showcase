import { ownerName } from "./instance";
import db from "./db";

// Side chats: short-lived extra conversations with the Chief of Staff that run alongside the
// main chat (so Owner isn't blocked while a long task runs there). Closing one merges it into
// the main feed: a collapsible transcript lands there, so the main chat (and the Chief of Staff
// reading its history) remembers what happened. Nothing is deleted — the thread's own rows
// stay in chat_history, and the thread is just marked merged.
//
// Every chat_history row with thread_id NULL is the main feed (briefings, PRs, etc. keep
// writing there unchanged).

db.exec(`
CREATE TABLE IF NOT EXISTS chat_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- open | merged
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  merged_at TEXT
);
`);
{
  const cols = db.prepare(`PRAGMA table_info(chat_history)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "thread_id")) db.exec(`ALTER TABLE chat_history ADD COLUMN thread_id INTEGER`);
}

export type ChatThread = { id: number; title: string | null; status: "open" | "merged"; created_at: string; merged_at: string | null };

// Which conversations have an agent reply in flight. On globalThis because each route file is
// its own module instance in dev, and both the chat route and the threads route need it.
const g = globalThis as unknown as { __chatRunning?: Set<string> };
const running = (g.__chatRunning ??= new Set<string>());
export const threadKey = (threadId: number | null) => (threadId ? String(threadId) : "main");
export const isRunning = (threadId: number | null) => running.has(threadKey(threadId));
export const setRunning = (threadId: number | null, on: boolean) =>
  on ? running.add(threadKey(threadId)) : running.delete(threadKey(threadId));
export const runningKeys = () => [...running];

export function listOpenThreads(): ChatThread[] {
  return db.prepare(`SELECT * FROM chat_threads WHERE status='open' ORDER BY id ASC`).all() as ChatThread[];
}

export function getThread(id: number): ChatThread | undefined {
  return db.prepare(`SELECT * FROM chat_threads WHERE id=?`).get(id) as ChatThread | undefined;
}

export function createThread(title?: string): ChatThread {
  const r = db.prepare(`INSERT INTO chat_threads (title) VALUES (?)`).run(title?.trim() || null);
  return getThread(Number(r.lastInsertRowid))!;
}

/** Name an untitled thread after its first message. */
export function autoTitle(id: number, firstMessage: string) {
  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 40) || "Side chat";
  db.prepare(`UPDATE chat_threads SET title=? WHERE id=? AND title IS NULL`).run(title, id);
}

type Row = { id: number; role: string; content: string; attachments: string | null; meta: string | null };

export function threadMessages(threadId: number | null, limit = 200): Row[] {
  const where = threadId ? `thread_id = ?` : `thread_id IS NULL`;
  const args = threadId ? [threadId, limit] : [limit];
  return (
    db
      .prepare(`SELECT id, role, content, attachments, meta FROM chat_history WHERE ${where} ORDER BY id DESC LIMIT ?`)
      .all(...args) as Row[]
  ).reverse();
}

const PER_MESSAGE = 2000;
const TOTAL = 16000;

/** Close a side chat by folding its transcript into the main feed. */
export function mergeThread(id: number) {
  const t = getThread(id);
  if (!t) throw new Error("Chat not found");
  if (t.status !== "open") throw new Error("That chat was already merged");
  if (isRunning(id)) throw new Error("That chat is still working. Wait for it to finish, then close it.");

  const rows = threadMessages(id, 1000);
  const title = t.title || `Side chat ${id}`;
  let mergedRowId: number | null = null;
  if (rows.length) {
    let transcript = rows
      .map((r) => {
        const text = r.content.length > PER_MESSAGE ? `${r.content.slice(0, PER_MESSAGE)}…` : r.content;
        return `**${r.role === "user" ? ownerName() : "Chief"}:** ${text}`;
      })
      .join("\n\n");
    if (transcript.length > TOTAL) transcript = `…(earlier messages trimmed)\n\n${transcript.slice(-TOTAL)}`;
    const content = `**Side chat merged: ${title}**\n\n<details>\n<summary>${rows.length} message${rows.length === 1 ? "" : "s"}, click to expand</summary>\n\n${transcript}\n\n</details>`;
    const r = db
      .prepare(`INSERT INTO chat_history (role, content, meta) VALUES ('assistant', ?, ?)`)
      .run(content, JSON.stringify({ type: "merged_thread", thread_id: id, title }));
    mergedRowId = Number(r.lastInsertRowid);
  }
  db.prepare(`UPDATE chat_threads SET status='merged', merged_at=datetime('now') WHERE id=?`).run(id);
  return { merged: true, thread_id: id, main_message_id: mergedRowId };
}
