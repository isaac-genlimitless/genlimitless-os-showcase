// TEXT CHIEF FROM ANYWHERE: an iMessage from Owner's own number to the OS is a chat turn in the
// main feed, exactly as if he'd typed it in the Chat tab, and Chief's answer is texted back.
//
// Safety:
//  - Only messages from OWNER_IMESSAGE_HANDLE, only 1:1 (never a group chat), and only over the
//    iMessage service. SMS sender ids can be spoofed, so an SMS "from Owner" is never treated as him.
//  - The reply goes only to OWNER_IMESSAGE_HANDLE (no recipient parameter anywhere).
//  - Own cursor in agent_state; it only advances after the turn finished, so a crash means retry.
//    On first run it starts at the newest message: old history is never replayed.
//  - The inbound sweep skips these messages (isOwnerTextHandle), so they aren't triaged twice.
import db, { getState, logIssue, setState } from "./db";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const CURSOR_KEY = "owner_text_rowid";
const MAX_REPLY = 1200;

const digits = (h: string) => {
  let d = h.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d;
};

function ownerHandle(): string {
  return (process.env.OWNER_IMESSAGE_HANDLE || "").trim();
}

/** Does this sender handle belong to Owner (same phone number or same iMessage email)? */
export function isOwnerTextHandle(handle: string | null | undefined, owner = ownerHandle()): boolean {
  if (!handle || !owner) return false;
  if (owner.includes("@") || handle.includes("@")) return handle.trim().toLowerCase() === owner.toLowerCase();
  const a = digits(handle);
  return a.length >= 7 && a === digits(owner);
}

export type OwnerText = { id: number; handle: string | null; chat_guid: string; service: string | null; text: string };

export type OwnerTextDeps = {
  owner?: string;
  latestRowid?: () => number;
  fetch?: (since: number) => OwnerText[];
  busy?: () => boolean;
  run?: (text: string) => Promise<{ reply: string }>;
  reply?: (text: string) => Promise<unknown>;
};

function defaultFetch(since: number): OwnerText[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const im = require("./imessage") as typeof import("./imessage");
  const rows = im
    .messagesDb()
    .prepare(
      `SELECT m.ROWID as id, h.id as handle, c.guid as chat_guid, m.service as service, m.text, m.attributedBody
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.associated_message_type = 0
       ORDER BY m.ROWID ASC LIMIT 200`
    )
    .all(since) as { id: number; handle: string | null; chat_guid: string; service: string | null; text: string | null; attributedBody: Buffer | null }[];
  return rows.map((r) => ({ ...r, text: (r.text ?? im.decodeAttributedBody(r.attributedBody) ?? "").replace(/￼/g, "").trim() }));
}

/** Messages that count as Owner talking to Chief. */
export function fromOwner(rows: OwnerText[], owner = ownerHandle()): OwnerText[] {
  return rows.filter(
    (r) => isOwnerTextHandle(r.handle, owner) && r.chat_guid.includes(";-;") && (r.service || "").toLowerCase() === "imessage" && r.text.length > 0
  );
}

/** Markdown-light for a phone screen: links become "text (url)", no bold/headers, capped. */
export function toPlainText(reply: string): string {
  const t = reply
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\((\/[^)]*)\)/g, "$1")
    .replace(/\*\*|__|^#+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > MAX_REPLY ? `${t.slice(0, MAX_REPLY - 40).trimEnd()}… (full reply in the OS chat)` : t;
}

async function defaultRun(text: string): Promise<{ reply: string }> {
  const { runAgent } = await import("./agent");
  const { threadMessages, threadKey, setRunning } = await import("./chat-threads");
  const { linkChatTurn } = await import("./undo-log");
  db.prepare(`INSERT INTO chat_history (role, content, meta) VALUES ('user', ?, ?)`).run(text, JSON.stringify({ via: "text" }));
  const recent = threadMessages(null, 15).map((r) => ({ role: r.role as "user" | "assistant", content: r.content.slice(0, 2500) }));
  let runId: number | null = null;
  setRunning(null, true);
  let reply: string;
  try {
    reply = await runAgent(
      recent,
      "",
      "[Owner TEXTED this from his phone. Your reply is texted back to him: plain text, under 600 characters, lead with the answer or the one thing he needs to do. Anything long goes on a Files page with the link.]\n\n",
      threadKey(null),
      { onRunId: (id) => (runId = id) }
    );
  } catch (err) {
    reply = `Something went wrong: ${errMsg(err)}`;
  } finally {
    setRunning(null, false);
  }
  const ins = db.prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant', ?)`).run(reply);
  const linked = runId as number | null;
  if (linked != null) await linkChatTurn(Number(ins.lastInsertRowid), linked, threadKey(null)).catch(() => {});
  return { reply };
}

async function defaultReply(text: string) {
  const to = ownerHandle();
  if (!to) return;
  const { trackedIMessage } = await import("./delivery");
  await trackedIMessage({ to, text: `Chief: ${text}`, purpose: "alert" });
}

let running = false;

/** Every minute. Returns how many of Owner's texts were answered. */
export async function runOwnerTextsTick(deps: OwnerTextDeps = {}): Promise<{ handled: number; skipped?: string }> {
  const owner = deps.owner ?? ownerHandle();
  if (!owner) return { handled: 0, skipped: "OWNER_IMESSAGE_HANDLE not set" };
  if (running) return { handled: 0, skipped: "already running" };
  running = true;
  try {
    let latest: number;
    let fetchRows: (since: number) => OwnerText[];
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      latest = deps.latestRowid ? deps.latestRowid() : (require("./imessage") as typeof import("./imessage")).latestMessageRowid();
      fetchRows = deps.fetch ?? defaultFetch;
    } catch {
      return { handled: 0, skipped: "Messages not readable" };
    }
    const stored = Number(getState(CURSOR_KEY));
    if (!getState(CURSOR_KEY) || !Number.isFinite(stored) || stored > latest) {
      setState(CURSOR_KEY, String(latest)); // first run (or chat.db rebuilt): start from now
      return { handled: 0, skipped: "cursor initialised" };
    }
    const rows = fetchRows(stored);
    if (!rows.length) return { handled: 0 };
    const mine = fromOwner(rows, owner);
    const maxId = Math.max(...rows.map((r) => r.id));
    if (!mine.length) {
      setState(CURSOR_KEY, String(maxId));
      return { handled: 0 };
    }
    if (deps.busy ? deps.busy() : (await import("./chat-threads")).isRunning(null)) return { handled: 0, skipped: "main chat busy; next minute" };
    const text = mine.map((m) => m.text).join("\n\n");
    const run = deps.run ?? defaultRun;
    let reply: string;
    try {
      ({ reply } = await run(text));
    } catch (err) {
      // Retry next minute, but never loop forever on one message: after 3 failures, move on.
      const tries = Number(getState(`${CURSOR_KEY}_tries_${maxId}`) || 0) + 1;
      setState(`${CURSOR_KEY}_tries_${maxId}`, String(tries));
      if (tries < 3) throw err;
      setState(CURSOR_KEY, String(maxId));
      reply = `Sorry, I couldn't handle that text (${errMsg(err).slice(0, 120)}). Try again or use the chat.`;
    }
    setState(CURSOR_KEY, String(maxId));
    try {
      await (deps.reply ?? defaultReply)(toPlainText(reply));
    } catch (err) {
      logIssue("owner_texts", "Couldn't text Chief's reply back to Owner (it's in the chat)", errMsg(err));
    }
    return { handled: mine.length };
  } catch (err) {
    logIssue("owner_texts", "Text-to-Chief tick failed; will retry", errMsg(err));
    return { handled: 0, skipped: "error" };
  } finally {
    running = false;
  }
}
