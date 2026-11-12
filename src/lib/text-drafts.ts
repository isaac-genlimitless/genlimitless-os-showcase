import db, { AllowlistEntry, TextDraft } from "./db";
import { displayName, loadContacts, messagesDb, normalizeHandle } from "./imessage";
import { trackedIMessage } from "./delivery";
import { addLearning } from "./agents/registry";
import { maybeScheduleAutopilot, recordDecision, textRecipient } from "./autopilot";

// Approval queue for agent-drafted texts (mirrors drafts.ts for email). Agents can only ever
// create a pending_approval row here: nothing sends until Owner approves it on the draft's
// review card in the Chief of Staff chat. The auto-send allowlist below only applies when a caller opts in with
// allowAutoSend, which no agent tool does (guardrail: nothing goes out without Owner's approval).

const AUTO_SEND_DAILY_LIMIT = 10;

// 1:1 chat guids end in the other person's handle ("any;-;+18015551234"); group chats ("any;+;...") don't.
const handleFromGuid = (guid?: string) => (guid && guid.includes(";-;") ? guid.split(";-;")[1] : undefined);

function resolveContactName(to?: string): string | null {
  if (!to) return null;
  try {
    const { byHandle } = loadContacts();
    const name = displayName(to, byHandle);
    return name !== to ? name : null;
  } catch {
    return null;
  }
}

// US numbers with a 555 area code or 555-01xx exchange are fictional (the e2e fixtures and
// anything an agent makes up look like this).
function isFictionalNumber(handle: string): boolean {
  if (handle.includes("@")) return false;
  const d = normalizeHandle(handle);
  return d.length === 10 && (d.startsWith("555") || /^\d{3}55501\d{2}$/.test(d));
}

/** On Owner's live data a text draft must go to someone real: an existing Messages chat, or a
 *  handle that's in his Contacts or already has a thread with him. Returns why not, or null.
 *  Explicit test servers (GLOS_TEST_SERVER=1) skip this, same as refuseTestFixture. */
function refuseUnknownRecipient(input: { to?: string; chat_guid?: string }): string | null {
  if (process.env.GLOS_TEST_SERVER === "1") return null;
  try {
    if (input.chat_guid) {
      const hit = messagesDb().prepare(`SELECT 1 FROM chat WHERE guid = ?`).get(input.chat_guid);
      return hit ? null : `No Messages conversation has chat_guid ${input.chat_guid}. Use the chat_guid from list_text_threads or get_text_thread.`;
    }
    const to = input.to!.trim();
    if (isFictionalNumber(to)) return `${to} is a fictional 555 number. Only draft texts to real people Owner knows.`;
    if (loadContacts().byHandle.has(normalizeHandle(to))) return null;
    const norm = normalizeHandle(to);
    const handles = messagesDb().prepare(`SELECT id FROM handle`).all() as { id: string }[];
    if (handles.some((h) => normalizeHandle(h.id) === norm)) return null;
    return `${to} isn't in Owner's Contacts and has never texted with him. Only draft texts to real contacts or existing threads (find_contact / list_text_threads).`;
  } catch (err: any) {
    return `Couldn't verify the recipient against Messages/Contacts (${err.message}), so no draft was made.`;
  }
}

/** Posts the draft into the main chat as a review card (ChatPanel renders meta.type "text_draft"). */
export function postTextDraftToChat(d: { id: number; contact_name: string | null; to_handle: string | null; reason: string | null }) {
  const who = d.contact_name || d.to_handle || "a group chat";
  db.prepare(`INSERT INTO chat_history (role, content, meta) VALUES ('assistant', ?, ?)`).run(
    `**Text draft for ${who}** is ready for your review.${d.reason ? `\n\n${d.reason}` : ""}`,
    JSON.stringify({ type: "text_draft", id: d.id })
  );
}

function isAllowlisted(handle: string): boolean {
  const norm = normalizeHandle(handle);
  const rows = db.prepare(`SELECT handle FROM text_autosend_allowlist`).all() as { handle: string }[];
  return rows.some((r) => normalizeHandle(r.handle) === norm);
}

function autoSendsToday(): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM text_drafts WHERE approved_by='agent_auto' AND created_at > datetime('now','-1 day')`
      )
      .get() as { c: number }
  ).c;
}

export async function createTextDraft(input: {
  to?: string;
  chat_guid?: string;
  text: string;
  reason?: string;
  suggested_send_at?: string;
}, opts: { allowAutoSend?: boolean } = {}): Promise<{ draft_id: number; status: "pending_approval" | "sent"; auto_sent?: boolean; autopilot_send_at?: string }> {
  if (!input.text || (!input.to && !input.chat_guid)) {
    throw new Error("text and (to or chat_guid) are required");
  }
  const refused = refuseUnknownRecipient(input);
  if (refused) throw new Error(refused);
  const result = db
    .prepare(
      `INSERT INTO text_drafts (to_handle, chat_guid, contact_name, text, reason, suggested_send_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending_approval')`
    )
    .run(
      input.to || null,
      input.chat_guid || null,
      resolveContactName(input.to || handleFromGuid(input.chat_guid)),
      input.text,
      input.reason || null,
      input.suggested_send_at || null
    );
  const id = Number(result.lastInsertRowid);

  // Auto-send only ever applies to a specific handle on the allowlist (never group chats),
  // and only under the daily cap. Anything else — or a failed send — stays in the queue.
  if (opts.allowAutoSend && input.to && isAllowlisted(input.to) && autoSendsToday() < AUTO_SEND_DAILY_LIMIT) {
    try {
      const send_id = await trackedIMessage({ to: input.to, text: input.text, purpose: "manual" });
      db.prepare(`UPDATE text_drafts SET status='sent', approved_by='agent_auto', send_id=? WHERE id=?`).run(
        send_id,
        id
      );
      return { draft_id: id, status: "sent", auto_sent: true };
    } catch {
      // Falls through and stays pending_approval, same as any other draft.
    }
  }

  postTextDraftToChat({
    id,
    contact_name: resolveContactName(input.to || handleFromGuid(input.chat_guid)),
    to_handle: input.to || handleFromGuid(input.chat_guid) || null,
    reason: input.reason || null,
  });
  // Owner's standing approval for this one person (Autopilot): sends after the hold window unless he
  // holds or changes it. Group chats never qualify (textRecipient returns null).
  const auto = maybeScheduleAutopilot("text", {
    id,
    recipient: textRecipient({ to_handle: input.to, chat_guid: input.chat_guid }),
    label: resolveContactName(input.to || handleFromGuid(input.chat_guid)) || input.to || null,
    body: input.text,
  });
  return auto ? { draft_id: id, status: "pending_approval", autopilot_send_at: auto.send_at } : { draft_id: id, status: "pending_approval" };
}

function getPendingDraft(id: number): TextDraft {
  const d = db.prepare(`SELECT * FROM text_drafts WHERE id = ?`).get(id) as TextDraft | undefined;
  if (!d) throw new Error(`Text draft ${id} not found`);
  if (d.status !== "pending_approval")
    throw new Error(`Text draft ${id} is ${d.status}; only pending_approval drafts can be changed`);
  return d;
}

export function editTextDraft(id: number, changes: { text?: string; suggested_send_at?: string }) {
  getPendingDraft(id);
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of ["text", "suggested_send_at"] as const) {
    if (changes[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(changes[k]);
    }
  }
  if (!sets.length) throw new Error("Nothing to change");
  db.prepare(`UPDATE text_drafts SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return { draft_id: id, status: "pending_approval", updated: true };
}

// Same as the Reject button: the row stays for the audit trail but leaves the queue.
export function rejectTextDraft(id: number) {
  const d = getPendingDraft(id);
  recordDecision("text", d.to_handle || handleFromGuid(d.chat_guid || undefined) || null, id, "rejected", d.contact_name);
  db.prepare(`UPDATE text_drafts SET status='cancelled' WHERE id = ?`).run(id);
  return { draft_id: id, status: "cancelled" };
}

export async function approveTextDraft(id: number, editedText?: string, opts: { by?: "owner" | "autopilot" } = {}) {
  const d = getPendingDraft(id);
  const text = editedText?.trim() ? editedText : d.text;
  // Group chats have no single recipient, so they never build an Autopilot track record.
  if (opts.by !== "autopilot" && (!d.chat_guid || d.chat_guid.includes(";-;"))) {
    recordDecision("text", d.to_handle || handleFromGuid(d.chat_guid || undefined) || null, id, text.trim() !== d.text.trim() ? "approved_edited" : "approved_unchanged", d.contact_name);
  }
  if (text.trim() !== d.text.trim()) {
    addLearning(
      "chief_of_staff",
      `Owner edited a text draft to ${d.contact_name || d.to_handle || "a contact"} before approving.\nDRAFT:\n${d.text.slice(0, 800)}\nWHAT HE SENT:\n${text.slice(0, 800)}`,
      "owner_edit",
      "raw"
    );
  }
  const send_id = await trackedIMessage({
    to: d.to_handle || undefined,
    chatGuid: d.chat_guid || undefined,
    text,
    purpose: "manual",
  });
  db.prepare(`UPDATE text_drafts SET status='sent', approved_by=?, text=?, send_id=? WHERE id = ?`).run(
    opts.by === "autopilot" ? "autopilot" : "owner",
    text,
    send_id,
    id
  );
  return { draft_id: id, status: "sent", send_id };
}

export function getTextDraft(id: number): TextDraft | undefined {
  return db.prepare(`SELECT * FROM text_drafts WHERE id = ?`).get(id) as TextDraft | undefined;
}

export function listTextDrafts(): TextDraft[] {
  return db.prepare(`SELECT * FROM text_drafts ORDER BY created_at DESC`).all() as TextDraft[];
}

export function listAllowlist(): AllowlistEntry[] {
  return db.prepare(`SELECT * FROM text_autosend_allowlist ORDER BY created_at DESC`).all() as AllowlistEntry[];
}

export function addAllowlistHandle(handle: string, label?: string): AllowlistEntry[] {
  db.prepare(`INSERT OR IGNORE INTO text_autosend_allowlist (handle, label) VALUES (?, ?)`).run(
    handle,
    label || null
  );
  return listAllowlist();
}

export function removeAllowlistHandle(id: number): AllowlistEntry[] {
  db.prepare(`DELETE FROM text_autosend_allowlist WHERE id = ?`).run(id);
  return listAllowlist();
}
