import Database from "better-sqlite3";
import { isOwnerCell } from "./instance";
import path from "path";
import fs from "fs";
import os from "os";
import { execFile } from "child_process";
import { DATA_DIR } from "./data-dir";

// Read-only bridge to Apple Messages (chat.db) and Apple Contacts (AddressBook).
// Both live under ~/Library and require Full Disk Access for the process running
// `next dev` (Terminal / iTerm / VS Code / Claude).

const HOME = os.homedir();
// On the server there is no Messages.app: a launchd job on Owner's Mac pushes a read-only copy of
// chat.db and the AddressBook into IMESSAGE_MIRROR_DIR (see bridge/), and we read that instead.
const MIRROR_DIR = process.env.IMESSAGE_MIRROR_DIR || "";
/** True on the server: texts are read from the mirror and sent by the Mac worker (bridge/send-worker.mjs). */
export const MIRROR_MODE = !!MIRROR_DIR;
const CHAT_DB = MIRROR_DIR ? path.join(MIRROR_DIR, "chat.db") : path.join(HOME, "Library/Messages/chat.db");
const AB_ROOT = MIRROR_DIR ? path.join(MIRROR_DIR, "AddressBook") : path.join(HOME, "Library/Application Support/AddressBook");
export const APPLE_EPOCH = 978307200; // 2001-01-01 in unix seconds

export class AccessError extends Error {}

function openReadonly(file: string) {
  try {
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch (err: any) {
    throw new AccessError(err.message);
  }
}

let chatDb: Database.Database | null = null;
let chatDbStamp = "";
export function messagesDb() {
  if (!isOwnerCell()) throw new AccessError("iMessage is not available in this account");
  if (MIRROR_DIR) {
    // The mirror is replaced by rename on every sync, so a cached handle would keep reading the old file.
    let stamp = "";
    try {
      const st = fs.statSync(CHAT_DB);
      stamp = `${st.ino}:${st.mtimeMs}`;
    } catch (err: any) {
      throw new AccessError(`iMessage mirror not found (${err.message}). Is the Mac sync running?`);
    }
    if (chatDb && stamp !== chatDbStamp) {
      chatDb.close();
      chatDb = null;
    }
    chatDbStamp = stamp;
  }
  if (!chatDb) chatDb = openReadonly(CHAT_DB);
  return chatDb;
}

/** Age of the mirrored chat.db in minutes (null when not running from a mirror or it's missing). */
export function mirrorAgeMinutes(): number | null {
  if (!MIRROR_DIR) return null;
  try {
    return (Date.now() - fs.statSync(path.join(MIRROR_DIR, ".last-sync")).mtimeMs) / 60_000;
  } catch {
    return null;
  }
}

/** Age in minutes of the send worker's poll heartbeat (written by bridge/outbox-cli.mjs); null if missing. */
export function bridgeHeartbeatAgeMinutes(): number | null {
  try {
    return (Date.now() - fs.statSync(path.join(DATA_DIR, ".bridge-heartbeat")).mtimeMs) / 60_000;
  } catch {
    return null;
  }
}

export function appleDate(v: number | null): string | null {
  if (!v) return null;
  const secs = v > 1e12 ? v / 1e9 : v; // newer macOS stores nanoseconds
  return new Date((secs + APPLE_EPOCH) * 1000).toISOString();
}

// Newer macOS leaves `text` NULL and stores the body in `attributedBody`
// (an NSAttributedString typedstream). Pull the first NSString payload out.
export function decodeAttributedBody(buf: Buffer | null): string | null {
  if (!buf) return null;
  const marker = buf.indexOf("NSString");
  if (marker < 0) return null;
  let i = buf.indexOf(0x2b, marker); // '+' precedes the length-prefixed string
  if (i < 0) return null;
  i++;
  let len = buf[i];
  i++;
  if (len === 0x81) {
    len = buf.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    len = buf.readUInt32LE(i);
    i += 4;
  }
  return buf.subarray(i, i + len).toString("utf8");
}

// ---------- Contacts ----------

export type Contact = {
  id: string;
  name: string;
  org: string | null;
  phones: string[];
  emails: string[];
};

export function normalizeHandle(h: string): string {
  if (h.includes("@")) return h.trim().toLowerCase();
  const digits = h.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

let contactCache: { at: number; contacts: Contact[]; byHandle: Map<string, Contact> } | null = null;

function addressBookFiles(): string[] {
  const files: string[] = [];
  const root = path.join(AB_ROOT, "AddressBook-v22.abcddb");
  if (fs.existsSync(root)) files.push(root);
  const sources = path.join(AB_ROOT, "Sources");
  try {
    for (const dir of fs.readdirSync(sources)) {
      const f = path.join(sources, dir, "AddressBook-v22.abcddb");
      if (fs.existsSync(f)) files.push(f);
    }
  } catch (err: any) {
    if (err.code === "EPERM" || err.code === "EACCES") throw new AccessError(err.message);
  }
  return files;
}

export function loadContacts(): { contacts: Contact[]; byHandle: Map<string, Contact> } {
  if (contactCache && Date.now() - contactCache.at < 5 * 60_000) return contactCache;
  const map = new Map<string, Contact>();
  for (const file of addressBookFiles()) {
    const ab = openReadonly(file);
    try {
      const rows = ab
        .prepare(
          `SELECT Z_PK as pk, ZFIRSTNAME as first, ZLASTNAME as last, ZORGANIZATION as org
           FROM ZABCDRECORD WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL OR ZORGANIZATION IS NOT NULL`
        )
        .all() as { pk: number; first: string | null; last: string | null; org: string | null }[];
      const phones = ab.prepare(`SELECT ZOWNER as o, ZFULLNUMBER as v FROM ZABCDPHONENUMBER`).all() as {
        o: number;
        v: string;
      }[];
      const emails = ab.prepare(`SELECT ZOWNER as o, ZADDRESS as v FROM ZABCDEMAILADDRESS`).all() as {
        o: number;
        v: string;
      }[];
      const local = new Map<number, Contact>();
      for (const r of rows) {
        const name = [r.first, r.last].filter(Boolean).join(" ") || r.org || "Unknown";
        local.set(r.pk, { id: `${path.basename(path.dirname(file))}:${r.pk}`, name, org: r.org, phones: [], emails: [] });
      }
      for (const p of phones) if (p.v) local.get(p.o)?.phones.push(p.v);
      for (const e of emails) if (e.v) local.get(e.o)?.emails.push(e.v);
      for (const c of local.values()) {
        // Dedupe across sources (iCloud + local) by name + first handle.
        const key = `${c.name}|${normalizeHandle(c.phones[0] || c.emails[0] || "")}`;
        const existing = map.get(key);
        if (existing) {
          existing.phones = [...new Set([...existing.phones, ...c.phones])];
          existing.emails = [...new Set([...existing.emails, ...c.emails])];
        } else map.set(key, c);
      }
    } finally {
      ab.close();
    }
  }
  const contacts = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  const byHandle = new Map<string, Contact>();
  for (const c of contacts) for (const h of [...c.phones, ...c.emails]) byHandle.set(normalizeHandle(h), c);
  contactCache = { at: Date.now(), contacts, byHandle };
  return contactCache;
}

function safeContacts() {
  try {
    return loadContacts();
  } catch {
    return { contacts: [] as Contact[], byHandle: new Map<string, Contact>() };
  }
}

export function displayName(handle: string | null, byHandle: Map<string, Contact>) {
  if (!handle) return "Unknown";
  return byHandle.get(normalizeHandle(handle))?.name || handle;
}

// ---------- Messages ----------

export type Thread = {
  chat_id: number;
  guid: string;
  title: string;
  handles: string[];
  is_group: boolean;
  last_text: string | null;
  last_at: string | null;
  last_from_me: boolean;
  unread: boolean;
  service: string;
};

export type IMessage = {
  id: number;
  chat_id: number;
  text: string;
  from_me: boolean;
  sender: string;
  at: string | null;
  service: string;
  has_attachment: boolean;
};

type RawMsg = {
  id: number;
  chat_id: number;
  text: string | null;
  attributedBody: Buffer | null;
  is_from_me: number;
  handle: string | null;
  date: number;
  service: string | null;
  cache_has_attachments: number;
};

function toMessage(r: RawMsg, byHandle: Map<string, Contact>): IMessage {
  return {
    id: r.id,
    chat_id: r.chat_id,
    text: (r.text ?? decodeAttributedBody(r.attributedBody) ?? "").replace(/￼/g, "").trim(),
    from_me: !!r.is_from_me,
    sender: r.is_from_me ? "Me" : displayName(r.handle, byHandle),
    at: appleDate(r.date),
    service: r.service || "iMessage",
    has_attachment: !!r.cache_has_attachments,
  };
}

export function listThreads(limit = 200, unreadOnly = false): Thread[] {
  const db = messagesDb();
  const { byHandle } = safeContacts();
  // Pull extra rows when filtering to unread so the post-filter result isn't
  // starved by read threads that happened to sort ahead of it.
  const fetchLimit = unreadOnly ? Math.min(Math.max(limit * 4, 200), 500) : limit;
  const chats = db
    .prepare(
      `SELECT c.ROWID as chat_id, c.guid, c.display_name, c.service_name,
              GROUP_CONCAT(h.id, '|') as handles,
              (SELECT MAX(m.date) FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id
               WHERE cmj.chat_id = c.ROWID) as last_date
       FROM chat c
       LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
       LEFT JOIN handle h ON h.ROWID = chj.handle_id
       GROUP BY c.ROWID
       HAVING last_date IS NOT NULL
       ORDER BY last_date DESC
       LIMIT ?`
    )
    .all(fetchLimit) as {
    chat_id: number;
    guid: string;
    display_name: string | null;
    service_name: string | null;
    handles: string | null;
    last_date: number;
  }[];

  const lastStmt = db.prepare(
    `SELECT m.ROWID as id, cmj.chat_id, m.text, m.attributedBody, m.is_from_me, NULL as handle, m.date,
            m.service, m.cache_has_attachments, m.is_read
     FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id
     WHERE cmj.chat_id = ? AND m.associated_message_type = 0 ORDER BY m.date DESC LIMIT 1`
  );

  const threads = chats.map((c) => {
    const handles = c.handles ? [...new Set(c.handles.split("|"))] : [];
    const names = handles.map((h) => displayName(h, byHandle));
    const last = lastStmt.get(c.chat_id) as (RawMsg & { is_read: number }) | undefined;
    const lm = last ? toMessage(last, byHandle) : null;
    return {
      chat_id: c.chat_id,
      guid: c.guid,
      title: c.display_name || names.join(", ") || c.guid,
      handles,
      is_group: handles.length > 1,
      last_text: lm ? lm.text || (lm.has_attachment ? "📎 Attachment" : "") : null,
      last_at: appleDate(c.last_date),
      last_from_me: lm?.from_me ?? false,
      unread: !!last && !last.is_from_me && !last.is_read,
      service: c.service_name || "iMessage",
    };
  });

  return unreadOnly ? threads.filter((t) => t.unread).slice(0, limit) : threads;
}

const MSG_SELECT = `SELECT m.ROWID as id, cmj.chat_id, m.text, m.attributedBody, m.is_from_me, h.id as handle,
       m.date, m.service, m.cache_has_attachments
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN handle h ON h.ROWID = m.handle_id`;

export function getThreadMessages(chatId: number, limit = 300): IMessage[] {
  const { byHandle } = safeContacts();
  const rows = messagesDb()
    .prepare(`${MSG_SELECT} WHERE cmj.chat_id = ? AND m.associated_message_type = 0 ORDER BY m.date DESC LIMIT ?`)
    .all(chatId, limit) as RawMsg[];
  return rows.reverse().map((r) => toMessage(r, byHandle)).filter((m) => m.text || m.has_attachment);
}

// Full-text search. `text` is indexed by LIKE directly; messages that only have an
// attributedBody are scanned in JS over the most recent window.
export function searchMessages(q: string, limit = 60): IMessage[] {
  const { byHandle } = safeContacts();
  const db = messagesDb();
  const like = `%${q}%`;
  const direct = db
    .prepare(`${MSG_SELECT} WHERE m.text LIKE ? ORDER BY m.date DESC LIMIT ?`)
    .all(like, limit) as RawMsg[];
  const needle = q.toLowerCase();
  const attributed = (
    db
      .prepare(`${MSG_SELECT} WHERE m.text IS NULL AND m.attributedBody IS NOT NULL ORDER BY m.date DESC LIMIT 20000`)
      .all() as RawMsg[]
  ).filter((r) => (decodeAttributedBody(r.attributedBody) || "").toLowerCase().includes(needle));
  return [...direct, ...attributed]
    .sort((a, b) => b.date - a.date)
    .slice(0, limit)
    .map((r) => toMessage(r, byHandle));
}

export function searchContacts(q: string, limit = 30): Contact[] {
  const needle = q.toLowerCase();
  const digits = q.replace(/\D/g, "");
  return loadContacts()
    .contacts.filter(
      (c) =>
        c.name.toLowerCase().includes(needle) ||
        (c.org || "").toLowerCase().includes(needle) ||
        c.emails.some((e) => e.toLowerCase().includes(needle)) ||
        (digits.length >= 3 && c.phones.some((p) => p.replace(/\D/g, "").includes(digits)))
    )
    .slice(0, limit);
}

// Find the existing chat for a handle so a contact click opens its thread.
export function chatIdForHandle(handle: string): number | null {
  const norm = normalizeHandle(handle);
  const rows = messagesDb()
    .prepare(
      `SELECT chj.chat_id, h.id as handle,
              (SELECT COUNT(*) FROM chat_handle_join x WHERE x.chat_id = chj.chat_id) as n
       FROM handle h JOIN chat_handle_join chj ON chj.handle_id = h.ROWID`
    )
    .all() as { chat_id: number; handle: string; n: number }[];
  return rows.find((r) => r.n === 1 && normalizeHandle(r.handle) === norm)?.chat_id ?? null;
}

// ---------- Inbound awareness ----------

export type InboundMessage = {
  id: number;
  chat_id: number;
  chat_guid: string;
  handle: string | null;
  contact_name: string;
  text: string;
  at: string | null;
};

// Texts Owner received (not sent) since a given message ROWID, oldest first, so the
// scheduler can hand the agent a compact summary without re-reading old messages.
export function newInboundMessages(sinceRowid: number, limit = 100): InboundMessage[] {
  const { byHandle } = safeContacts();
  const rows = messagesDb()
    .prepare(
      `SELECT m.ROWID as id, cmj.chat_id, c.guid as chat_guid, h.id as handle, m.text, m.attributedBody, m.date
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.associated_message_type = 0
       ORDER BY m.ROWID ASC LIMIT ?`
    )
    .all(sinceRowid, limit) as {
    id: number;
    chat_id: number;
    chat_guid: string;
    handle: string | null;
    text: string | null;
    attributedBody: Buffer | null;
    date: number;
  }[];
  return rows
    .map((r) => ({
      id: r.id,
      chat_id: r.chat_id,
      chat_guid: r.chat_guid,
      handle: r.handle,
      contact_name: displayName(r.handle, byHandle),
      text: (r.text ?? decodeAttributedBody(r.attributedBody) ?? "").replace(/￼/g, "").trim(),
      at: appleDate(r.date),
    }))
    .filter((m) => m.text);
}

export function latestMessageRowid(): number {
  const row = messagesDb().prepare(`SELECT COALESCE(MAX(ROWID), 0) as id FROM message`).get() as { id: number };
  return row.id;
}

// ---------- Sending (via Messages.app / AppleScript) ----------

export function sendIMessage(opts: { to?: string; chatGuid?: string; text: string }): Promise<void> {
  if (!isOwnerCell()) return Promise.reject(new Error("iMessage is not available in this account"));
  if (MIRROR_DIR) return Promise.reject(new Error("The server queues iMessages for the Mac worker; it can't call Messages.app itself"));
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = opts.chatGuid
    ? `tell application "Messages" to send "${esc(opts.text)}" to chat id "${esc(opts.chatGuid)}"`
    : `tell application "Messages"
         set svc to 1st account whose service type = iMessage
         send "${esc(opts.text)}" to participant "${esc(opts.to || "")}" of svc
       end tell`;
  return new Promise((resolve, reject) =>
    execFile("osascript", ["-e", script], (err, _out, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve()
    )
  );
}
