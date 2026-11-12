import db, { logIssue, type MailAccountRow } from "./db";
import * as legacy from "./mail";
import * as gmail from "./gmail";
import { sanitizeEmailHtml, htmlLooksReal } from "./email-html";
import { sealToken, openToken } from "./token-seal";

// Idempotent one-time migration: encrypt any legacy plaintext refresh tokens. Never blanks a token.
try {
  const legacyRows = db
    .prepare("SELECT id, refresh_token FROM mail_accounts WHERE refresh_token IS NOT NULL AND refresh_token NOT LIKE 'enc:v1:%'")
    .all() as { id: number; refresh_token: string }[];
  for (const r of legacyRows) {
    const sealed = sealToken(r.refresh_token);
    if (sealed) db.prepare("UPDATE mail_accounts SET refresh_token=? WHERE id=?").run(sealed, r.id);
  }
} catch (err: any) {
  logIssue("mail_accounts", "Encrypting stored Gmail refresh tokens failed", err?.message ?? String(err));
}

// Single interface every caller (scheduler, delivery, agent, API routes) goes through.
// Hides whether a given address is Gmail OAuth or the legacy env-var app-password account.

export type MailAccount = {
  email: string;
  label: string;
  kind: "gmail_oauth" | "legacy_app_password";
  status: "connected" | "needs_reconnect";
  scopes?: string | null;
  /** Live IMAP watch health; only set for legacy_app_password accounts. */
  health?: WatchHealth;
};

export type WatchHealth = {
  state: "ok" | "reconnecting" | "down";
  /** "credentials" when Google rejected the app password; "network" otherwise. */
  reason?: "credentials" | "network";
  last_ok_at: string | null; // SQLite UTC 'YYYY-MM-DD HH:MM:SS'
  down_since: string | null;
  last_error: string | null;
};

/** How long an outage stays "reconnecting" before the UI calls it "down". */
const RECONNECTING_GRACE_MIN = 15;

/** Pure classification of an imap_watch_state row (nowMs injectable for tests). */
export function classifyWatchHealth(
  row: { status: string; last_ok_at: string | null; last_seen_at?: string | null; down_since: string | null; last_error: string | null } | undefined,
  nowMs: number = Date.now()
): WatchHealth {
  const lastOk = row ? row.last_ok_at || row.last_seen_at || null : null;
  if (!row) return { state: "reconnecting", last_ok_at: null, down_since: null, last_error: null };
  if (row.status !== "error") {
    return { state: row.status === "watching" ? "ok" : "reconnecting", last_ok_at: lastOk, down_since: null, last_error: null };
  }
  const authFailed = /AUTHENTICATIONFAILED|Invalid credentials/i.test(row.last_error || "");
  const downSinceMs = row.down_since ? new Date(row.down_since.replace(" ", "T") + "Z").getTime() : nowMs;
  const longDown = nowMs - downSinceMs >= RECONNECTING_GRACE_MIN * 60_000;
  return {
    state: authFailed || longDown ? "down" : "reconnecting",
    reason: authFailed ? "credentials" : "network",
    last_ok_at: lastOk,
    down_since: row.down_since,
    last_error: row.last_error,
  };
}

/** Live health of the IMAP IDLE watch for one app-password account (reads imap_watch_state). */
export function getWatchHealth(email: string): WatchHealth {
  const row = db
    .prepare(
      `SELECT status, last_ok_at, last_seen_at, down_since, last_error FROM imap_watch_state WHERE lower(account) = lower(?)`
    )
    .get(email) as Parameters<typeof classifyWatchHealth>[0];
  return classifyWatchHealth(row);
}

export type EmailMessage = {
  id: string; // gmail message id, or "imap:<uid>" for the legacy account
  threadId?: string;
  account: string;
  from: string;
  to: string;
  subject: string;
  date: string; // ISO
  snippet: string;
  text: string;
  messageIdHeader?: string;
  references?: string;
  html?: string;
  hasRemoteImages?: boolean;
  labels?: string[];
  category?: "primary" | "social" | "promotions" | "updates" | "forums" | "other";
  unread?: boolean;
  body_source?: "plain" | "html" | "snippet";
};

/** Extra app-password Gmail accounts from .env.local: every GMAIL_<NAME>_USER with a matching
 *  GMAIL_<NAME>_APP_PASSWORD (e.g. GMAIL_PERSONAL_USER). Add a line pair per account, no code needed. */
function extraAppPasswordAccounts(): { name: string; creds: legacy.AppPasswordCreds }[] {
  const out: { name: string; creds: legacy.AppPasswordCreds }[] = [];
  for (const [key, user] of Object.entries(process.env)) {
    const m = key.match(/^GMAIL_([A-Z0-9]+)_USER$/);
    const pass = m && process.env[`GMAIL_${m[1]}_APP_PASSWORD`];
    if (m && user && pass) out.push({ name: m[1].toLowerCase(), creds: { user, pass: pass.replace(/\s+/g, "") } });
  }
  return out;
}

/** Credentials for an app-password account, or undefined for the primary (GMAIL_USER) one. */
function appPasswordCreds(email: string): legacy.AppPasswordCreds | undefined {
  return extraAppPasswordAccounts().find((a) => a.creds.user.toLowerCase() === email.toLowerCase())?.creds;
}

/** Concrete IMAP app-password credentials for a legacy_app_password account (never undefined,
 *  unlike appPasswordCreds above) - for the IMAP IDLE watcher, which opens its own connections
 *  per account rather than going through mail.ts's default-credentials fallback. */
export function legacyImapCreds(email: string): legacy.AppPasswordCreds {
  const extra = appPasswordCreds(email);
  if (extra) return extra;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (user && pass && user.toLowerCase() === email.toLowerCase()) return { user, pass };
  throw new Error(`No app-password credentials found for ${email}`);
}

function oauthRows(): MailAccountRow[] {
  return db.prepare(`SELECT * FROM mail_accounts ORDER BY connected_at ASC`).all() as MailAccountRow[];
}

function oauthRow(email: string): MailAccountRow {
  const row = db.prepare(`SELECT * FROM mail_accounts WHERE email = ?`).get(email) as MailAccountRow | undefined;
  if (!row) throw new Error(`No Gmail account connected for ${email}`);
  return row;
}

/** All accounts available to send/read from: connected Gmail OAuth accounts, plus the
 *  legacy env-var account(s) as a fallback so nothing breaks before Owner connects OAuth. */
export function listAccounts(): MailAccount[] {
  const rows = oauthRows();
  const oauthEmails = new Set(rows.map((r) => r.email.toLowerCase()));
  const accounts: MailAccount[] = rows.map((r) => ({
    email: r.email,
    label: r.label || r.email,
    kind: "gmail_oauth",
    status: r.status === "needs_reconnect" ? "needs_reconnect" : "connected",
    scopes: r.scopes,
  }));

  const legacyUser = process.env.GMAIL_USER;
  if (legacyUser && process.env.GMAIL_APP_PASSWORD && !oauthEmails.has(legacyUser.toLowerCase())) {
    accounts.push({
      email: legacyUser,
      label: "business (legacy)",
      kind: "legacy_app_password",
      status: "connected",
      health: getWatchHealth(legacyUser),
    });
  }
  for (const extra of extraAppPasswordAccounts()) {
    if (accounts.some((a) => a.email.toLowerCase() === extra.creds.user.toLowerCase())) continue;
    accounts.push({
      email: extra.creds.user,
      label: `${extra.name} (app password)`,
      kind: "legacy_app_password",
      status: "connected",
      health: getWatchHealth(extra.creds.user),
    });
  }
  return accounts;
}

function findAccount(email: string): MailAccount {
  const account = listAccounts().find((a) => a.email.toLowerCase() === email.toLowerCase());
  if (!account) throw new Error(`No mail account connected for ${email}`);
  return account;
}

/** Best-guess default sender when a caller doesn't specify one (e.g. email drafts). */
export function defaultAccountEmail(): string | null {
  const accounts = listAccounts();
  if (accounts.length === 0) return null;
  const legacyUser = process.env.GMAIL_USER;
  return accounts.find((a) => a.email.toLowerCase() === (legacyUser || "").toLowerCase())?.email || accounts[0].email;
}

async function withGmailAuth<T>(row: MailAccountRow, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof gmail.GmailAuthError) {
      db.prepare(`UPDATE mail_accounts SET status='needs_reconnect' WHERE email=?`).run(row.email);
      logIssue("mail_accounts", `Gmail account ${row.email} needs to be reconnected`, err.message);
      throw new Error(`${row.email} needs to be reconnected in Settings (${err.code})`);
    }
    throw err;
  }
}

function withSanitizedHtml(raw: string | undefined): { html?: string; hasRemoteImages?: boolean } {
  if (!raw || !htmlLooksReal(raw)) return {};
  const s = sanitizeEmailHtml(raw);
  return s ? { html: s.html, hasRemoteImages: s.hasRemoteImages } : {};
}

function legacyToUnified(
  m: Awaited<ReturnType<typeof legacy.fetchRecentInbox>>[number],
  account: string,
  full = false
): EmailMessage {
  return {
    id: `imap:${m.uid}`,
    account,
    from: m.from,
    to: m.to,
    subject: m.subject,
    date: m.date.toISOString(),
    snippet: m.text.slice(0, 200),
    text: full && m.fullText ? m.fullText : m.text,
    messageIdHeader: m.messageId,
    references: m.references,
    ...(full ? withSanitizedHtml(m.html) : {}),
  };
}

function gmailToUnified(m: gmail.GmailMessage, account: string, full = false): EmailMessage {
  return {
    id: m.id,
    threadId: m.threadId,
    account,
    from: m.from,
    to: m.to,
    subject: m.subject,
    date: m.date,
    snippet: m.snippet,
    text: m.text,
    messageIdHeader: m.messageIdHeader,
    references: m.references,
    labels: m.labels,
    category: m.category,
    unread: m.unread,
    body_source: m.body_source,
    ...(full ? withSanitizedHtml(m.html) : {}),
  };
}

function matchesQuery(m: EmailMessage, q: string) {
  const needle = q.toLowerCase();
  return (
    m.subject.toLowerCase().includes(needle) ||
    m.text.toLowerCase().includes(needle) ||
    m.from.toLowerCase().includes(needle) ||
    m.to.toLowerCase().includes(needle)
  );
}

export async function listInbox(email: string, opts: { limit?: number; q?: string } = {}): Promise<EmailMessage[]> {
  const account = findAccount(email);
  if (account.kind === "legacy_app_password") {
    const items = await legacy.fetchRecentInbox(opts.limit ?? 20, appPasswordCreds(account.email));
    const unified = items.map((m) => legacyToUnified(m, account.email));
    return opts.q ? unified.filter((m) => matchesQuery(m, opts.q!)) : unified;
  }
  const row = oauthRow(account.email);
  const items = await withGmailAuth(row, () => gmail.listMessages(row, opts));
  return items.map((m) => gmailToUnified(m, account.email));
}

export async function getThread(email: string, threadId: string): Promise<EmailMessage[]> {
  const account = findAccount(email);
  if (account.kind === "legacy_app_password") {
    // IMAP has no thread concept here; a single fetched message is its own "thread".
    const items = await legacy.fetchRecentInbox(50, appPasswordCreds(account.email));
    const match = items.find((m) => `imap:${m.uid}` === threadId);
    return match ? [legacyToUnified(match, account.email, true)] : [];
  }
  const row = oauthRow(account.email);
  const items = await withGmailAuth(row, () => gmail.getThread(row, threadId));
  return items.map((m) => gmailToUnified(m, account.email, true));
}

/** RFC Message-ID we mint ourselves (rather than trust whatever the provider auto-assigns) so
 *  we know it before the send round-trips, and can record it as messages.message_ref for
 *  In-Reply-To/References thread-chaining on the inbound side (see inbound-email.ts). */
/** Cheap health probe for one connected account; throws on failure. App-password accounts: SMTP
 *  verify (connect+EHLO+AUTH, nothing sent) + IMAP login/NOOP. Gmail OAuth: a 1-message inbox read. */
export async function probeAccount(email: string): Promise<void> {
  const account = findAccount(email);
  if (account.kind === "legacy_app_password") {
    const creds = legacyImapCreds(account.email);
    await legacy.verifySmtp(creds);
    await legacy.probeImap(creds);
    return;
  }
  await listInbox(account.email, { limit: 1 });
}

/** Did this Message-ID already reach the account's Sent folder? null = couldn't check (so the
 *  caller must hold, never resend). */
export async function sentFolderHas(email: string, messageId: string): Promise<boolean | null> {
  try {
    const account = findAccount(email);
    if (account.kind !== "legacy_app_password") return null;
    return await legacy.sentHasMessageId(messageId, legacyImapCreds(account.email));
  } catch {
    return null;
  }
}

export type SendErrorClass = "safe_retry" | "uncertain" | "permanent";

const NET_CODES = new Set(["ETIMEDOUT", "ECONNECTION", "ESOCKET", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET"]);
const PRE_DATA_COMMANDS = new Set(["CONN", "EHLO", "STARTTLS", "AUTH"]);

/** safe_retry: nothing could have been transmitted (failed at connect/EHLO/STARTTLS/AUTH).
 *  permanent: auth rejected or a 5xx reject. uncertain: anything else (at/after DATA, or unknown),
 *  where the server may have accepted the mail, so check Sent before any resend. */
export function classifySendError(err: any): SendErrorClass {
  const code = String(err?.code ?? "");
  const command = String(err?.command ?? "");
  const response = Number(err?.responseCode ?? 0);
  if (code === "EAUTH" || response === 535 || command === "AUTH PLAIN" || command === "AUTH LOGIN") return "permanent";
  if (response >= 500 && response < 600) return "permanent";
  if (NET_CODES.has(code) && PRE_DATA_COMMANDS.has(command)) return "safe_retry";
  // Resolver/refused errors carry no SMTP command but can only happen before any connection exists.
  if (!command && ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code)) return "safe_retry";
  return "uncertain";
}

export function mintMessageId(): string {
  return `<${Date.now()}.${Math.random().toString(36).slice(2)}@genlimitless-os>`;
}

export async function sendEmail(opts: {
  account: string;
  to: string;
  subject: string;
  text: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  /** Pre-minted Message-ID: pass the same one on every retry so a resend is detectable. */
  messageId?: string;
}): Promise<{ id: string; threadId?: string; messageId: string }> {
  const account = findAccount(opts.account);
  const messageId = opts.messageId || mintMessageId();
  if (account.kind === "legacy_app_password") {
    const info = await legacy.sendEmail({
      creds: appPasswordCreds(account.email),
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
      messageId,
    });
    return { id: String(info.messageId || messageId), messageId };
  }
  const row = oauthRow(account.email);
  const result = await withGmailAuth(row, () =>
    gmail.sendMessage(row, {
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      threadId: opts.threadId,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
      messageId,
    })
  );
  return { ...result, messageId };
}

export function upsertOAuthAccount(opts: { email: string; label: string; refreshToken: string; scopes: string }) {
  if (!opts.refreshToken) throw new Error("Refusing to store a Gmail account without a refresh token");
  db.prepare(
    `INSERT INTO mail_accounts (email, label, kind, refresh_token, scopes, status, connected_at)
     VALUES (?, ?, 'gmail_oauth', ?, ?, 'connected', datetime('now'))
     ON CONFLICT(email) DO UPDATE SET
       label = excluded.label,
       refresh_token = excluded.refresh_token,
       scopes = excluded.scopes,
       status = 'connected',
       connected_at = datetime('now')`
  ).run(opts.email, opts.label || opts.email, sealToken(opts.refreshToken), opts.scopes);
}

export async function disconnectAccount(email: string) {
  const row = db.prepare(`SELECT * FROM mail_accounts WHERE email = ?`).get(email) as MailAccountRow | undefined;
  if (!row) throw new Error(`${email} isn't a connected Gmail account`);
  if (row.refresh_token) {
    try {
      await gmail.revokeToken(openToken(row.refresh_token)!);
    } catch (err: any) {
      logIssue("mail_accounts", `Revoking Google's grant for ${email} failed (removing it locally anyway)`, err.message);
    }
  }
  db.prepare(`DELETE FROM mail_accounts WHERE email = ?`).run(email);
}

// ---------- Read-only access for the Chief of Staff's mail tools ----------

export type MailHeader = {
  account: string;
  from: string;
  to: string;
  subject: string;
  date: string; // ISO
  messageId: string;
  inReplyTo: string;
  references: string;
};

/** Lightweight headers from one folder, for analysis (send-time stats etc.). */
export async function listHeaders(email: string, folder: "inbox" | "sent", limit: number): Promise<MailHeader[]> {
  const account = findAccount(email);
  if (account.kind === "legacy_app_password") {
    const items = await legacy.fetchHeaders(folder, limit, appPasswordCreds(account.email));
    return items.map((m) => ({
      account: account.email,
      from: m.from,
      to: m.to,
      subject: m.subject,
      date: m.date.toISOString(),
      messageId: m.messageId,
      inReplyTo: m.inReplyTo,
      references: m.references,
    }));
  }
  const row = oauthRow(account.email);
  const items = await withGmailAuth(row, () => gmail.listMessages(row, { limit, q: folder === "sent" ? "in:sent" : "in:inbox" }));
  return items.map((m) => ({
    account: account.email,
    from: m.from,
    to: m.to,
    subject: m.subject,
    date: m.date,
    messageId: m.messageIdHeader || "",
    inReplyTo: "",
    references: m.references || "",
  }));
}

/** Search a whole mailbox with Gmail's search syntax. */
export async function searchMail(
  email: string,
  opts: { folder: "inbox" | "sent" | "all"; q: string; limit?: number; full?: boolean }
): Promise<EmailMessage[]> {
  const account = findAccount(email);
  const limit = opts.limit ?? 20;
  if (account.kind === "legacy_app_password") {
    const items = await legacy.searchMailbox(opts.folder, opts.q, limit, appPasswordCreds(account.email), !!opts.full);
    return items.map((m) => legacyToUnified(m, account.email, !!opts.full));
  }
  const row = oauthRow(account.email);
  const q = `${opts.folder === "sent" ? "in:sent" : opts.folder === "inbox" ? "in:inbox" : ""} ${opts.q}`.trim();
  const items = await withGmailAuth(row, () => gmail.listMessages(row, { limit, q }));
  return items.map((m) => gmailToUnified(m, account.email));
}

/** Paged search. Gmail accounts follow nextPageToken; IMAP accounts fall back to searchMail (no token). */
export async function searchMailPage(
  email: string,
  opts: { folder: "inbox" | "sent" | "all"; q: string; limit?: number; pageToken?: string }
): Promise<{ messages: EmailMessage[]; nextPageToken?: string }> {
  const account = findAccount(email);
  if (account.kind === "legacy_app_password") {
    return { messages: await searchMail(email, { folder: opts.folder, q: opts.q, limit: opts.limit, full: true }) };
  }
  const row = oauthRow(account.email);
  const q = `${opts.folder === "sent" ? "in:sent" : opts.folder === "inbox" ? "in:inbox" : ""} ${opts.q}`.trim();
  const page = await withGmailAuth(row, () =>
    gmail.listMessagesPage(row, { limit: opts.limit ?? 20, q, pageToken: opts.pageToken })
  );
  return { messages: page.messages.map((m) => gmailToUnified(m, account.email)), nextPageToken: page.nextPageToken };
}

// ---------- Full-mailbox access by RFC Message-ID (read anything, organize, trash) ----------

/** The whole thread around a message, oldest first. `ref` is a Message-ID header or a Gmail thread/message id. */
export async function readThread(email: string, ref: string): Promise<EmailMessage[]> {
  const account = findAccount(email);
  if (account.kind === "legacy_app_password") {
    if (ref.startsWith("imap:")) return getThread(email, ref); // old-style handle from the recent inbox
    const items = await legacy.fetchThreadByMessageId(ref, appPasswordCreds(account.email));
    return items.map((m) => legacyToUnified(m, account.email));
  }
  const row = oauthRow(account.email);
  if (ref.includes("@")) {
    const [id] = await withGmailAuth(row, () => gmail.idsForMessageIds(row, [ref]));
    if (!id) return [];
    const msg = await withGmailAuth(row, () => gmail.getMessage(row, id));
    return getThread(email, msg.threadId);
  }
  return getThread(email, ref);
}

export type OrganizeAction = legacy.OrganizeAction;

/** Mark read/unread, star, archive, move back to inbox, add/remove a label. Never deletes. */
export async function organizeMail(email: string, messageIds: string[], action: OrganizeAction, label?: string) {
  const account = findAccount(email);
  if (account.kind === "legacy_app_password") {
    return legacy.organizeByMessageId(messageIds, action, label, appPasswordCreds(account.email));
  }
  const row = oauthRow(account.email);
  const ids = await withGmailAuth(row, () => gmail.idsForMessageIds(row, messageIds));
  const change: Record<OrganizeAction, { add?: string[]; remove?: string[] }> = {
    mark_read: { remove: ["UNREAD"] },
    mark_unread: { add: ["UNREAD"] },
    star: { add: ["STARRED"] },
    unstar: { remove: ["STARRED"] },
    archive: { remove: ["INBOX"] },
    move_to_inbox: { add: ["INBOX"] },
    add_label: { add: [label || ""] },
    remove_label: { remove: [label || ""] },
  };
  if ((action === "add_label" || action === "remove_label") && !label) throw new Error("label is required");
  await withGmailAuth(row, () => gmail.modifyLabels(row, ids, change[action]));
  return { changed: ids.length };
}

export type MailMsgState = { unread: boolean; starred: boolean; inbox: boolean; labeled: boolean };

/** Current flags of Gmail messages (by Gmail id). Gmail accounts only. Read-only. */
export async function readMailState(email: string, gmailIds: string[], label?: string | null): Promise<Record<string, MailMsgState>> {
  const account = findAccount(email);
  if (account.kind === "legacy_app_password") throw new Error("This mailbox type can't be restored automatically");
  const row = oauthRow(account.email);
  const labels = await withGmailAuth(row, () => gmail.labelIdsFor(row, gmailIds));
  const lid = label ? await withGmailAuth(row, () => gmail.labelIdByName(row, label)) : null;
  const out: Record<string, MailMsgState> = {};
  for (const id of gmailIds) {
    const l = labels[id] || [];
    out[id] = { unread: l.includes("UNREAD"), starred: l.includes("STARRED"), inbox: l.includes("INBOX"), labeled: !!lid && l.includes(lid) };
  }
  return out;
}

/** State of the messages before an organize call, or null for non-Gmail accounts or on any error. */
export async function snapshotMailState(email: string, messageIds: string[], label?: string | null) {
  try {
    const account = findAccount(email);
    if (account.kind === "legacy_app_password") return null;
    const row = oauthRow(account.email);
    const ids = await withGmailAuth(row, () => gmail.idsForMessageIds(row, messageIds));
    return { kind: "gmail" as const, state: await readMailState(email, ids, label) };
  } catch {
    return null;
  }
}

/** Label changes only (no trash, no delete). */
export async function changeMailLabels(email: string, gmailIds: string[], change: { add?: string[]; remove?: string[] }) {
  const account = findAccount(email);
  if (account.kind === "legacy_app_password") throw new Error("This mailbox type can't be restored automatically");
  const row = oauthRow(account.email);
  await withGmailAuth(row, () => gmail.modifyLabels(row, gmailIds, change));
}

/** Move to Trash (recoverable for 30 days). Only ever called after Owner approves it. */
export async function trashMail(email: string, messageIds: string[]) {
  const account = findAccount(email);
  if (account.kind === "legacy_app_password") return legacy.trashByMessageId(messageIds, appPasswordCreds(account.email));
  const row = oauthRow(account.email);
  const ids = await withGmailAuth(row, () => gmail.idsForMessageIds(row, messageIds));
  for (const id of ids) await withGmailAuth(row, () => gmail.trashMessage(row, id));
  return { trashed: ids.length };
}
