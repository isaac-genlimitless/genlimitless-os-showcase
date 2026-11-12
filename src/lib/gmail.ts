import type { MailAccountRow } from "./db";
import { bestPlainText } from "./email-text";
import { openToken } from "./token-seal";

// Gmail REST API client (OAuth, gmail.modify scope). Deliberately narrow: list/get/send/trash
// only. Never call messages.delete or threads.delete — gmail.modify can't do that permanently,
// and that's a feature, not a gap.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_SCOPES = `openid email ${GMAIL_SCOPE}`;

export class GmailNotConfigured extends Error {}
export class GmailAuthError extends Error {
  code: string;
  constructor(code: string) {
    super(`Gmail token error: ${code}`);
    this.code = code;
  }
}

function clientCreds() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret)
    throw new GmailNotConfigured("Google isn't set up: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing from .env.local.");
  return { id, secret };
}

export function authUrl(origin: string, state: string) {
  const { id } = clientCreds();
  const p = new URLSearchParams({
    client_id: id,
    redirect_uri: `${origin}/api/google/callback`,
    response_type: "code",
    scope: GMAIL_SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/** Exchange an auth code for tokens and resolve which Gmail address was granted. */
export async function exchangeCode(code: string, origin: string) {
  const { id, secret } = clientCreds();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: id,
      client_secret: secret,
      redirect_uri: `${origin}/api/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail token exchange failed: ${JSON.stringify(data)}`);
  if (!data.refresh_token)
    throw new Error(
      "Google didn't return a refresh token. Remove GenLimitless from https://myaccount.google.com/permissions and try Connect Gmail again."
    );

  const profile = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${data.access_token}` },
  }).then((r) => r.json());
  const email = profile.emailAddress as string | undefined;
  if (!email) throw new Error("Couldn't read the connected Gmail address from the profile response");

  return { email, refreshToken: data.refresh_token as string, scope: (data.scope as string) || GMAIL_SCOPES };
}

async function accessToken(row: Pick<MailAccountRow, "refresh_token">): Promise<string> {
  const { id, secret } = clientCreds();
  if (!row.refresh_token) throw new GmailAuthError("missing_refresh_token");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: openToken(row.refresh_token)!,
      client_id: id,
      client_secret: secret,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new GmailAuthError(data.error || "unknown");
  return data.access_token as string;
}

async function api(row: Pick<MailAccountRow, "refresh_token">, path: string, init: RequestInit = {}) {
  const token = await accessToken(row);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Gmail API ${path} failed: ${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

function headerValue(headers: { name: string; value: string }[] | undefined, name: string) {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function decodeBody(data?: string) {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

// Collect the first text/plain and first text/html parts anywhere in the message.
function collectBodies(payload: any, out: { plain: string; html: string } = { plain: "", html: "" }) {
  if (!payload) return out;
  if (payload.mimeType === "text/plain" && payload.body?.data && !out.plain) out.plain = decodeBody(payload.body.data);
  else if (payload.mimeType === "text/html" && payload.body?.data && !out.html) out.html = decodeBody(payload.body.data);
  for (const part of payload.parts || []) collectBodies(part, out);
  if (!payload.parts && !payload.mimeType && payload.body?.data && !out.plain) out.plain = decodeBody(payload.body.data);
  return out;
}

// Prefer real plain text; convert HTML when there's no plain part or the "plain" part is HTML.
function extractText(payload: any): string {
  const { plain, html } = collectBodies(payload);
  return bestPlainText(plain, html);
}

export type GmailMessage = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  text: string;
  messageIdHeader: string;
  references: string;
  html?: string;
  labels: string[];
  category?: "primary" | "social" | "promotions" | "updates" | "forums" | "other";
  unread: boolean;
  body_source: "plain" | "html" | "snippet";
};

function categoryFromLabels(labels: string[]): GmailMessage["category"] {
  const c = labels.find((l) => l.startsWith("CATEGORY_"));
  if (!c) return "primary";
  const k = c.slice(9).toLowerCase();
  if (k === "personal") return "primary";
  return (["social", "promotions", "updates", "forums"].includes(k) ? k : "other") as GmailMessage["category"];
}

function toGmailMessage(data: any, withHtml = false): GmailMessage {
  const headers = data.payload?.headers;
  const bodies = collectBodies(data.payload);
  const html = withHtml ? bodies.html : "";
  const extracted = bestPlainText(bodies.plain, bodies.html);
  const labels: string[] = data.labelIds || [];
  const body_source: GmailMessage["body_source"] = !extracted
    ? "snippet"
    : bodies.html && (!bodies.plain || extracted !== bestPlainText(bodies.plain, "")) ? "html" : "plain";
  return {
    ...(html ? { html } : {}),
    labels,
    category: categoryFromLabels(labels),
    unread: labels.includes("UNREAD"),
    body_source,
    id: data.id,
    threadId: data.threadId,
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    subject: headerValue(headers, "Subject"),
    date: data.internalDate ? new Date(Number(data.internalDate)).toISOString() : new Date().toISOString(),
    snippet: data.snippet || "",
    text: extracted || data.snippet || "",
    messageIdHeader: headerValue(headers, "Message-ID"),
    references: headerValue(headers, "References"),
  };
}

export async function getMessage(row: MailAccountRow, id: string): Promise<GmailMessage> {
  const data = await api(row, `/messages/${id}?format=full`);
  return toGmailMessage(data);
}

export async function listMessages(
  row: MailAccountRow,
  opts: { limit?: number; q?: string } = {}
): Promise<GmailMessage[]> {
  const limit = opts.limit ?? 20;
  if (limit > 100) return (await listMessagesPage(row, { limit, q: opts.q })).messages;
  const params = new URLSearchParams({ maxResults: String(limit) });
  if (opts.q) params.set("q", opts.q);
  const data = await api(row, `/messages?${params}`);
  const ids: string[] = (data.messages || []).map((m: any) => m.id);
  return Promise.all(ids.map((id) => getMessage(row, id)));
}

/** Like listMessages but follows nextPageToken until `limit` is reached and returns the next token. */
export async function listMessagesPage(
  row: MailAccountRow,
  opts: { limit?: number; q?: string; pageToken?: string } = {}
): Promise<{ messages: GmailMessage[]; nextPageToken?: string }> {
  const limit = opts.limit ?? 20;
  const ids: string[] = [];
  let token = opts.pageToken;
  let next: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: String(Math.min(100, limit - ids.length)) });
    if (opts.q) params.set("q", opts.q);
    if (token) params.set("pageToken", token);
    const data = await api(row, `/messages?${params}`);
    for (const m of data.messages || []) ids.push(m.id);
    next = data.nextPageToken || undefined;
    token = next;
  } while (token && ids.length < limit);
  const messages = await Promise.all(ids.slice(0, limit).map((id) => getMessage(row, id)));
  return { messages, nextPageToken: next };
}

export async function getThread(row: MailAccountRow, threadId: string): Promise<GmailMessage[]> {
  const data = await api(row, `/threads/${threadId}?format=full`);
  return (data.messages || []).map((m: any) => toGmailMessage(m, true));
}

function b64url(s: string) {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sendMessage(
  row: MailAccountRow,
  opts: {
    to: string;
    subject: string;
    text: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
    messageId?: string;
  }
): Promise<{ id: string; threadId: string }> {
  const lines = [
    `From: ${row.email}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (opts.messageId) lines.push(`Message-ID: ${opts.messageId}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push("", opts.text);

  const body: Record<string, string> = { raw: b64url(lines.join("\r\n")) };
  if (opts.threadId) body.threadId = opts.threadId;

  const data = await api(row, "/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { id: data.id, threadId: data.threadId };
}

/** Gmail message ids for RFC Message-ID headers. */
export async function idsForMessageIds(row: MailAccountRow, messageIds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const mid of messageIds) {
    const q = `rfc822msgid:${mid.replace(/^<|>$/g, "")}`;
    const data = await api(row, `/messages?${new URLSearchParams({ q, includeSpamTrash: "false", maxResults: "5" })}`);
    out.push(...((data.messages || []) as { id: string }[]).map((m) => m.id));
  }
  return [...new Set(out)];
}

async function labelId(row: MailAccountRow, name: string, create: boolean): Promise<string | null> {
  const data = await api(row, "/labels");
  const hit = ((data.labels || []) as { id: string; name: string }[]).find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;
  if (!create) return null;
  const made = await api(row, "/labels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  return made.id;
}

/** Read-only: the id of an existing label by name, or null. */
export async function labelIdByName(row: MailAccountRow, name: string): Promise<string | null> {
  return labelId(row, name, false);
}

/** Read-only: current label ids of each message. */
export async function labelIdsFor(row: MailAccountRow, ids: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const id of ids) {
    const d = await api(row, `/messages/${id}?format=minimal`);
    out[id] = d.labelIds || [];
  }
  return out;
}

/** Add/remove labels (INBOX, UNREAD, STARRED or a user label by name). Non-destructive. */
export async function modifyLabels(row: MailAccountRow, ids: string[], opts: { add?: string[]; remove?: string[] }) {
  const resolve = async (names: string[] = [], create: boolean) =>
    (await Promise.all(names.map((n) => (/^(INBOX|UNREAD|STARRED)$/.test(n) ? n : labelId(row, n, create))))).filter(Boolean) as string[];
  const addLabelIds = await resolve(opts.add, true);
  const removeLabelIds = await resolve(opts.remove, false);
  for (const id of ids) {
    await api(row, `/messages/${id}/modify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
  }
}

/** Move to Trash — never a permanent delete. Only call this from an explicit UI action. */
export async function trashMessage(row: MailAccountRow, id: string) {
  await api(row, `/messages/${id}/trash`, { method: "POST" });
}

export async function revokeToken(refreshToken: string) {
  await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken }),
  });
}
