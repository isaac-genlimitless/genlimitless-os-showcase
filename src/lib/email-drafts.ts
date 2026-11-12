import db from "./db";
import { listAccounts, sendEmail, classifySendError, mintMessageId, sentFolderHas } from "./mail-accounts";
import { accountIsDown, recordHealth } from "./mail-health";
import { addLearning } from "./agents/registry";
import { maybeScheduleAutopilot, recordDecision, singleEmail } from "./autopilot";

// Approval queue for emails to ANYONE (clients, partners, personal replies).
// Agents can only create and edit pending drafts here; nothing sends until Owner clicks
// Approve & send in Communications → Email. Discarding is soft (status 'cancelled').

db.exec(`
CREATE TABLE IF NOT EXISTS email_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,                  -- connected account it sends from
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  in_reply_to TEXT,                       -- Message-ID being replied to (keeps it in the thread)
  refs TEXT,
  gmail_thread_id TEXT,
  reason TEXT,                            -- why the agent drafted it
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval', -- pending_approval | sent | cancelled | failed
  error TEXT,
  sent_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
`);

export type EmailDraft = {
  id: number;
  account: string;
  to_addr: string;
  subject: string;
  body: string;
  in_reply_to: string | null;
  refs: string | null;
  gmail_thread_id: string | null;
  reason: string | null;
  created_by: string;
  status: "pending_approval" | "approved_sending" | "sent" | "cancelled" | "failed";
  error: string | null;
  sent_message_id: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

function connectedAccount(email: string): string {
  const hit = listAccounts().find((a) => a.email.toLowerCase() === email.toLowerCase() && a.status === "connected");
  if (!hit) throw new Error(`${email} isn't a connected mail account. Connected: ${listAccounts().map((a) => a.email).join(", ")}`);
  return hit.email;
}

export function getEmailDraft(id: number): EmailDraft | undefined {
  return db.prepare(`SELECT * FROM email_drafts WHERE id=?`).get(id) as EmailDraft | undefined;
}

function pending(id: number): EmailDraft {
  const d = getEmailDraft(id);
  if (!d) throw new Error(`Email draft ${id} not found`);
  if (d.status !== "pending_approval") throw new Error(`Email draft ${id} is ${d.status}; only pending drafts can change`);
  return d;
}

export function createEmailDraft(input: {
  account: string;
  to: string;
  subject: string;
  body: string;
  in_reply_to?: string;
  references?: string;
  thread_id?: string;
  reason?: string;
  created_by: string;
}) {
  if (!input.to?.trim() || !input.body?.trim()) throw new Error("to and body are required");
  const account = connectedAccount(input.account);
  const refs = input.in_reply_to ? [input.references, input.in_reply_to].filter(Boolean).join(" ").trim() : input.references || null;
  const r = db
    .prepare(
      `INSERT INTO email_drafts (account, to_addr, subject, body, in_reply_to, refs, gmail_thread_id, reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(account, input.to.trim(), input.subject || "", input.body, input.in_reply_to || null, refs, input.thread_id || null, input.reason || null, input.created_by);
  const draftId = Number(r.lastInsertRowid);
  // Recipient on Autopilot (Owner's standing approval for that one person): scheduled to send after the
  // hold window unless he holds or changes it. Everyone else: waits for his click as always.
  const auto = maybeScheduleAutopilot("email", { id: draftId, recipient: singleEmail(input.to), label: input.to.trim(), body: `${input.to.trim()}\n${input.subject || ""}\n${input.body}` });
  if (auto) return { draft_id: draftId, status: "pending_approval", autopilot_send_at: auto.send_at, note: `Owner has ${auto.label} on Autopilot: this sends automatically after the hold window unless he holds it.` };
  return { draft_id: draftId, status: "pending_approval", note: "Waiting for Owner in Communications → Email." };
}

export function editEmailDraft(id: number, changes: { to?: string; subject?: string; body?: string; account?: string }) {
  pending(id);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (changes.to !== undefined) { sets.push("to_addr=?"); vals.push(changes.to); }
  if (changes.subject !== undefined) { sets.push("subject=?"); vals.push(changes.subject); }
  if (changes.body !== undefined) { sets.push("body=?"); vals.push(changes.body); }
  if (changes.account !== undefined) { sets.push("account=?"); vals.push(connectedAccount(changes.account)); }
  if (!sets.length) throw new Error("Nothing to change");
  db.prepare(`UPDATE email_drafts SET ${sets.join(", ")}, updated_at=datetime('now') WHERE id=?`).run(...vals, id);
  return { draft_id: id, status: "pending_approval", updated: true };
}

export function listEmailDrafts(status: EmailDraft["status"] | "all" = "pending_approval", limit = 50): EmailDraft[] {
  return (
    status === "all"
      ? db.prepare(`SELECT * FROM email_drafts ORDER BY id DESC LIMIT ?`).all(limit)
      : db.prepare(`SELECT * FROM email_drafts WHERE status=? ORDER BY id DESC LIMIT ?`).all(status, limit)
  ) as EmailDraft[];
}

/** Owner's Approve & send, or Autopilot acting on his standing approval for this one recipient
 *  (src/lib/autopilot.ts rechecks every rule before calling this). The only path from this queue to a send. */
export async function approveEmailDraft(id: number, edited?: { subject?: string; body?: string; to?: string }, opts: { by?: "owner" | "autopilot" } = {}) {
  const d = pending(id);
  const body = edited?.body?.trim() ? edited.body : d.body;
  const subject = edited?.subject ?? d.subject;
  const to = edited?.to?.trim() || d.to_addr;
  if (opts.by !== "autopilot") {
    const changed = body.trim() !== d.body.trim() || subject !== d.subject || to !== d.to_addr;
    recordDecision("email", d.to_addr, id, changed ? "approved_edited" : "approved_unchanged", d.to_addr);
  }
  if (body.trim() !== d.body.trim()) {
    // How Owner rewrites a draft is the best signal of his voice; the CoS's nightly review learns from it.
    addLearning(
      "chief_of_staff",
      `Owner edited an email draft to ${to} before sending.\nDRAFT:\n${d.body.slice(0, 1500)}\nWHAT HE SENT:\n${body.slice(0, 1500)}`,
      "owner_edit",
      "raw"
    );
  }
  // Owner's click IS the approval. Record it (and the Message-ID, minted once) BEFORE the send
  // attempt, so a failed attempt can be retried with the same Message-ID without ever picking up
  // a draft Owner didn't approve.
  const sendId = d.sent_message_id || mintMessageId();
  db.prepare(
    `UPDATE email_drafts SET status='approved_sending', to_addr=?, subject=?, body=?, sent_message_id=?, updated_at=datetime('now') WHERE id=? AND status='pending_approval'`
  ).run(to, subject, body, sendId, id);
  return attemptDraftSend(getEmailDraft(id)!, true);
}

async function attemptDraftSend(d: EmailDraft, rethrow: boolean) {
  try {
    const sent = await sendEmail({
      account: d.account,
      to: d.to_addr,
      subject: d.subject,
      text: d.body,
      threadId: d.gmail_thread_id || undefined,
      inReplyTo: d.in_reply_to || undefined,
      references: d.refs || undefined,
      messageId: d.sent_message_id || undefined,
    });
    db.prepare(
      `UPDATE email_drafts SET status='sent', sent_message_id=?, error=NULL, sent_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).run(sent.messageId, d.id);
    recordHealth(d.account, true);
    return { draft_id: d.id, status: "sent" };
  } catch (err: any) {
    const cls = classifySendError(err);
    recordHealth(d.account, false, err?.message || String(err));
    // safe_retry / uncertain: stay 'approved_sending' (the retry pass resends, checking Sent first when
    // unsure). permanent: back to pending_approval so Owner sees it and fixes the cause.
    const status = cls === "permanent" ? "pending_approval" : "approved_sending";
    db.prepare(`UPDATE email_drafts SET status=?, error=?, updated_at=datetime('now') WHERE id=?`).run(status, `${cls}: ${err.message}`, d.id);
    if (rethrow) throw err;
    return { draft_id: d.id, status };
  }
}

/** Retry pass (every minute from the scheduler): ONLY drafts Owner already approved
 *  ('approved_sending'), at most one per account per pass, 5+ min after the last attempt. */
export async function retryApprovedDrafts() {
  const rows = db
    .prepare(`SELECT * FROM email_drafts WHERE status='approved_sending' AND updated_at <= datetime('now', '-5 minutes') ORDER BY id ASC`)
    .all() as EmailDraft[];
  const done = new Set<string>();
  for (const d of rows) {
    const key = d.account.toLowerCase();
    if (done.has(key) || accountIsDown(key)) continue;
    done.add(key);
    if (d.sent_message_id && !(d.error || "").startsWith("safe_retry")) {
      const found = await sentFolderHas(d.account, d.sent_message_id);
      if (found === true) {
        db.prepare(`UPDATE email_drafts SET status='sent', error=NULL, sent_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(d.id);
        continue;
      }
      if (found === null) {
        db.prepare(`UPDATE email_drafts SET updated_at=datetime('now') WHERE id=?`).run(d.id); // hold, never resend blind
        continue;
      }
    }
    await attemptDraftSend(d, false);
  }
}

/** Owner's Discard: soft, kept for the record. */
export function discardEmailDraft(id: number) {
  const d = pending(id);
  recordDecision("email", d.to_addr, id, "rejected", d.to_addr);
  db.prepare(`UPDATE email_drafts SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(id);
  return { draft_id: id, status: "cancelled" };
}
