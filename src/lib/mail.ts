import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { bestPlainText } from "./email-text";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// An app-password Gmail account. Omitted = the primary account from GMAIL_USER / GMAIL_APP_PASSWORD.
export type AppPasswordCreds = { user: string; pass: string };

function primaryCreds(): AppPasswordCreds {
  return { user: requireEnv("GMAIL_USER"), pass: requireEnv("GMAIL_APP_PASSWORD") };
}

// Short network timeouts: nodemailer's defaults (2 min connect, 10 min socket) let one dead-network
// attempt block the whole send loop for minutes.
const connectTimeoutMs = () => Number(process.env.SMTP_CONNECT_TIMEOUT_MS || 20_000);

export function getTransporter(creds: AppPasswordCreds = primaryCreds(), portOverride?: number) {
  // 587 + STARTTLS by default: the the VPS server blocks outbound 465. SMTP_PORT=465 still works elsewhere.
  const port = portOverride ?? Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: creds.user, pass: creds.pass },
    connectionTimeout: connectTimeoutMs(),
    greetingTimeout: 15_000,
    socketTimeout: 45_000,
  });
}

/** Cheap SMTP probe: connect + EHLO + AUTH, no mail sent. Throws on failure. */
export async function verifySmtp(creds?: AppPasswordCreds) {
  await getTransporter(creds ?? primaryCreds()).verify();
}

/** Cheap IMAP probe: login + NOOP. Throws on failure. */
export async function probeImap(creds?: AppPasswordCreds) {
  const client = getImapClient(creds ?? primaryCreds());
  client.on("error", () => {});
  await client.connect();
  try {
    await client.noop();
  } finally {
    await client.logout().catch(() => {});
  }
}

/** True if a message with this Message-ID is already in the account's Sent mail (Gmail search). */
export async function sentHasMessageId(messageId: string, creds?: AppPasswordCreds): Promise<boolean> {
  const clean = messageId.replace(/^<|>$/g, "");
  const hits = await searchMailbox("sent", `rfc822msgid:${clean}`, 1, creds);
  return hits.length > 0;
}

const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderEmailBody(body: string): { text: string; html: string } {
  const text = body.replace(LINK_RE, "$1 ($2)");
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">' +
    esc(body).replace(LINK_RE, '<a href="$2">$1</a>').replace(/\n/g, "<br>") +
    "</div>";
  return { text, html };
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  messageId?: string;
  creds?: AppPasswordCreds;
}) {
  const creds = opts.creds ?? primaryCreds();
  const from = creds.user;
  const { text, html } = renderEmailBody(opts.text);
  const mail = {
    from,
    to: opts.to,
    subject: opts.subject,
    text,
    html,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
    messageId: opts.messageId,
  };
  try {
    return await getTransporter(creds).sendMail(mail);
  } catch (err: any) {
    // Many hosts block one SMTP port and not the other. A connect-phase timeout on 465 means nothing
    // was transmitted, so trying 587 STARTTLS (requireTLS) is safe.
    const port = Number(process.env.SMTP_PORT || 587);
    if (port === 465 && err?.code === "ETIMEDOUT" && err?.command === "CONN") {
      return await getTransporter(creds, 587).sendMail(mail);
    }
    throw err;
  }
}

type MailSummary = {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: Date;
  text: string;
  messageId: string;
  references: string;
  html?: string;
  fullText?: string;
};

function getImapClient(creds: AppPasswordCreds = primaryCreds()) {
  return new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  });
}

async function fetchRecentFromMailbox(mailbox: string, limit: number, creds?: AppPasswordCreds, full = false): Promise<MailSummary[]> {
  const client = getImapClient(creds);
  const results: MailSummary[] = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const status = await client.status(mailbox, { messages: true });
      const total = status.messages || 0;
      if (total === 0) return results;
      const start = Math.max(1, total - limit + 1);
      for await (const msg of client.fetch(`${start}:*`, {
        envelope: true,
        source: { maxLength: full ? 2_000_000 : 80_000 },
      })) {
        const parsed = await simpleParser(msg.source as Buffer);
        results.push({
          fullText: bestPlainText(parsed.text, parsed.html),
          html: typeof parsed.html === "string" ? parsed.html : undefined,
          uid: msg.uid,
          from: parsed.from?.text || "",
          to: Array.isArray(parsed.to)
            ? parsed.to.map((t) => t.text).join(", ")
            : parsed.to?.text || "",
          subject: parsed.subject || "",
          date: parsed.date || new Date(),
          text: full ? bestPlainText(parsed.text, parsed.html) : bestPlainText(parsed.text, parsed.html).slice(0, 4000),
          messageId: parsed.messageId || "",
          references: Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references || "",
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return results.sort((a, b) => b.date.getTime() - a.date.getTime());
}

export async function fetchRecentInbox(limit = 25, creds?: AppPasswordCreds, full = false) {
  return fetchRecentFromMailbox("INBOX", limit, creds, full);
}

async function findSentMailboxName(creds?: AppPasswordCreds): Promise<string> {
  const client = getImapClient(creds);
  await client.connect();
  try {
    const list = await client.list();
    const sent = list.find((m) => m.specialUse === "\\Sent");
    if (sent) return sent.path;
    const fallback = list.find((m) => /sent/i.test(m.name));
    return fallback?.path || "[Gmail]/Sent Mail";
  } finally {
    await client.logout();
  }
}

export async function fetchSentMail(limit = 40, creds?: AppPasswordCreds) {
  const mailbox = await findSentMailboxName(creds);
  return fetchRecentFromMailbox(mailbox, limit, creds);
}

// ---------- Read-only helpers for the Chief of Staff's mail tools ----------

export type HeaderSummary = {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: Date;
  messageId: string;
  inReplyTo: string;
  references: string;
};

const addrList = (a?: { address?: string }[]) => (a || []).map((x) => x.address || "").filter(Boolean).join(", ");

async function resolveMailbox(folder: "inbox" | "sent" | "all", creds?: AppPasswordCreds) {
  if (folder === "all") {
    const client = getImapClient(creds);
    await client.connect();
    try {
      return (await client.list()).find((m) => m.specialUse === "\\All")?.path || "[Gmail]/All Mail";
    } finally {
      await client.logout();
    }
  }
  return folder === "sent" ? findSentMailboxName(creds) : "INBOX";
}

/** Headers only (no bodies/attachments), so hundreds of messages are cheap to pull. */
export async function fetchHeaders(folder: "inbox" | "sent", limit: number, creds?: AppPasswordCreds): Promise<HeaderSummary[]> {
  const mailbox = await resolveMailbox(folder, creds);
  const client = getImapClient(creds);
  const out: HeaderSummary[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const total = (await client.status(mailbox, { messages: true })).messages || 0;
      if (!total) return out;
      const start = Math.max(1, total - limit + 1);
      for await (const msg of client.fetch(`${start}:*`, { envelope: true, headers: ["references"] })) {
        const env = msg.envelope;
        if (!env) continue;
        out.push({
          uid: msg.uid,
          from: addrList(env.from),
          to: addrList(env.to),
          subject: env.subject || "",
          date: env.date ? new Date(env.date) : new Date(0),
          messageId: env.messageId || "",
          inReplyTo: env.inReplyTo || "",
          references: msg.headers ? msg.headers.toString().replace(/^references:\s*/i, "").replace(/\s+/g, " ").trim() : "",
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return out.sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** Server-side Gmail search (Gmail's own syntax: from:, to:, subject:, newer_than:30d, "exact phrase"). */
export async function searchMailbox(
  folder: "inbox" | "sent" | "all",
  q: string,
  limit: number,
  creds?: AppPasswordCreds,
  full = false
): Promise<MailSummary[]> {
  const mailbox = await resolveMailbox(folder, creds);
  const client = getImapClient(creds);
  const out: MailSummary[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const uids = ((await client.search({ gmraw: q }, { uid: true })) || []) as number[];
      const pick = uids.slice(-limit);
      if (!pick.length) return out;
      for await (const msg of client.fetch(pick, { envelope: true, source: { maxLength: full ? 2_000_000 : 80_000 } }, { uid: true })) {
        const parsed = await simpleParser(msg.source as Buffer);
        const bodyText = bestPlainText(parsed.text, parsed.html);
        out.push({
          ...(full ? { fullText: bodyText } : {}),
          uid: msg.uid,
          from: parsed.from?.text || "",
          to: Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(", ") : parsed.to?.text || "",
          subject: parsed.subject || "",
          date: parsed.date || new Date(),
          text: full ? bodyText : bodyText.slice(0, 4000),
          messageId: parsed.messageId || "",
          references: Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references || "",
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return out.sort((a, b) => b.date.getTime() - a.date.getTime());
}

// ---------- Whole-mailbox access by Message-ID (Gmail over IMAP) ----------
// Messages are addressed by their RFC Message-ID header, not a folder UID, so a message found
// in Sent, Inbox or an archived label is the same handle everywhere. Everything runs in Gmail's
// "All Mail", where flags and labels are global, so it works whatever folder a message sits in.

async function specialMailbox(client: ImapFlow, use: "\\All" | "\\Trash", fallback: string) {
  const list = await client.list();
  return list.find((m) => m.specialUse === use)?.path || fallback;
}

async function uidsForMessageIds(client: ImapFlow, messageIds: string[]): Promise<number[]> {
  const uids: number[] = [];
  for (const id of messageIds) {
    const clean = id.replace(/^<|>$/g, "");
    const hit = ((await client.search({ gmraw: `rfc822msgid:${clean}` }, { uid: true })) || []) as number[];
    uids.push(...hit);
  }
  return [...new Set(uids)];
}

/** Full thread containing a message (Gmail X-GM-THRID), oldest first. */
export async function fetchThreadByMessageId(messageId: string, creds?: AppPasswordCreds, maxMessages = 15): Promise<MailSummary[]> {
  const client = getImapClient(creds);
  const out: MailSummary[] = [];
  await client.connect();
  try {
    const all = await specialMailbox(client, "\\All", "[Gmail]/All Mail");
    const lock = await client.getMailboxLock(all);
    try {
      const [uid] = await uidsForMessageIds(client, [messageId]);
      if (!uid) return out;
      let threadId: string | undefined;
      for await (const m of client.fetch(String(uid), { threadId: true }, { uid: true })) threadId = m.threadId;
      const uids = threadId ? (((await client.search({ threadId }, { uid: true })) || []) as number[]) : [uid];
      for await (const msg of client.fetch(uids.slice(-maxMessages), { source: { maxLength: 200_000 } }, { uid: true })) {
        const parsed = await simpleParser(msg.source as Buffer);
        out.push({
          uid: msg.uid,
          from: parsed.from?.text || "",
          to: Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(", ") : parsed.to?.text || "",
          subject: parsed.subject || "",
          date: parsed.date || new Date(),
          text: bestPlainText(parsed.text, parsed.html).slice(0, 12000),
          messageId: parsed.messageId || "",
          references: Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references || "",
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export type OrganizeAction = "mark_read" | "mark_unread" | "star" | "unstar" | "archive" | "move_to_inbox" | "add_label" | "remove_label";

/** Non-destructive mailbox organizing. Trash is separate (trashByMessageId) and needs Owner's approval. */
export async function organizeByMessageId(messageIds: string[], action: OrganizeAction, label: string | undefined, creds?: AppPasswordCreds) {
  const client = getImapClient(creds);
  await client.connect();
  try {
    const all = await specialMailbox(client, "\\All", "[Gmail]/All Mail");
    const lock = await client.getMailboxLock(all);
    try {
      const uids = await uidsForMessageIds(client, messageIds);
      if (!uids.length) return { changed: 0 };
      const opts = { uid: true };
      const labelOpts = { uid: true, useLabels: true };
      switch (action) {
        case "mark_read": await client.messageFlagsAdd(uids, ["\\Seen"], opts); break;
        case "mark_unread": await client.messageFlagsRemove(uids, ["\\Seen"], opts); break;
        case "star": await client.messageFlagsAdd(uids, ["\\Flagged"], opts); break;
        case "unstar": await client.messageFlagsRemove(uids, ["\\Flagged"], opts); break;
        case "archive": await client.messageFlagsRemove(uids, ["\\Inbox"], labelOpts); break;
        case "move_to_inbox": await client.messageFlagsAdd(uids, ["\\Inbox"], labelOpts); break;
        case "add_label":
          if (!label) throw new Error("label is required");
          if (!(await client.list()).some((m) => m.path === label)) await client.mailboxCreate(label);
          await client.messageFlagsAdd(uids, [label], labelOpts);
          break;
        case "remove_label":
          if (!label) throw new Error("label is required");
          await client.messageFlagsRemove(uids, [label], labelOpts);
          break;
      }
      return { changed: uids.length };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

/** Move to Trash (Gmail empties it after 30 days, so it's recoverable until then). Only after Owner approves. */
export async function trashByMessageId(messageIds: string[], creds?: AppPasswordCreds) {
  const client = getImapClient(creds);
  await client.connect();
  try {
    const all = await specialMailbox(client, "\\All", "[Gmail]/All Mail");
    const trash = await specialMailbox(client, "\\Trash", "[Gmail]/Trash");
    const lock = await client.getMailboxLock(all);
    try {
      const uids = await uidsForMessageIds(client, messageIds);
      if (uids.length) await client.messageMove(uids, trash, { uid: true });
      return { trashed: uids.length };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}
