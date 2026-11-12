import db from "./db";
import { centralDateKey } from "./time";
import { logActivity } from "./agents/registry";
import { bareAddress, hasEnded, staleEmailReasons, staleTextReasons, textKey, Conv } from "./proposal-lifecycle-core";

// Visibility + undo for retired proposals. Reads retired rows and flips status back. Never sends, never deletes.
export type RetiredKind = "email" | "text" | "calendar";
export type RetiredItem = { kind: RetiredKind; id: number; title: string; why: string; status: string; created_at: string };

const suffixWhy = (reason: string | null | undefined) => {
  const m = (reason || "").match(/\[Superseded([^\]]*)\]\s*$/);
  return m ? `Superseded${m[1]}`.trim() : "Superseded";
};

export function listRetired(days = 14, limit = 30): RetiredItem[] {
  const since = `-${Math.max(1, Math.floor(days))} days`;
  const out: RetiredItem[] = [];
  for (const r of db.prepare(`SELECT id, to_addr, subject, error, status, created_at FROM email_drafts WHERE status='superseded' AND created_at >= datetime('now', ?) ORDER BY created_at DESC, id DESC LIMIT ?`).all(since, limit) as any[])
    out.push({ kind: "email", id: r.id, title: `Email to ${r.to_addr}${r.subject ? `: ${r.subject}` : ""}`, why: r.error || "Superseded", status: r.status, created_at: r.created_at });
  for (const r of db.prepare(`SELECT id, to_handle, contact_name, reason, status, created_at FROM text_drafts WHERE status='superseded' AND created_at >= datetime('now', ?) ORDER BY created_at DESC, id DESC LIMIT ?`).all(since, limit) as any[])
    out.push({ kind: "text", id: r.id, title: `Text to ${r.contact_name || r.to_handle || "a group chat"}`, why: suffixWhy(r.reason), status: r.status, created_at: r.created_at });
  for (const r of db.prepare(`SELECT id, title, reason, status, created_at FROM schedule_items WHERE status IN ('superseded','expired') AND created_at >= datetime('now', ?) ORDER BY created_at DESC, id DESC LIMIT ?`).all(since, limit) as any[])
    out.push({ kind: "calendar", id: r.id, title: `Calendar block: ${r.title}`, why: r.status === "expired" ? "Its end time passed" : suffixWhy(r.reason), status: r.status, created_at: r.created_at });
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id));
  return out.slice(0, limit);
}

export function restoreProposal(input: { kind: RetiredKind | string; id: number; by: string }) {
  const id = Number(input.id);
  const by = input.by || "owner";
  if (!Number.isInteger(id) || id <= 0) throw new Error("A valid id is required");
  let label = "";
  if (input.kind === "email") {
    const d = db.prepare(`SELECT * FROM email_drafts WHERE id=?`).get(id) as any;
    if (!d) throw new Error(`Email draft ${id} not found`);
    if (d.status !== "superseded") throw new Error(`Email draft ${id} is ${d.status}, not retired; nothing to restore`);
    const conv = (r: any, at: string): Conv => ({ id: r.id, address: bareAddress(r.to_addr), subject: r.subject || "", thread: r.gmail_thread_id, at });
    const others = db.prepare(`SELECT id, to_addr, subject, gmail_thread_id, in_reply_to, created_at FROM email_drafts WHERE status='pending_approval'`).all() as any[];
    const pending = [d, ...others].map((r) => ({ ...conv(r, r.created_at), isReply: !!r.in_reply_to || /^\s*re\s*:/i.test(r.subject || "") }));
    const later: any[] = pending.map((p) => ({ ...p, kind: "draft" as const }));
    for (const r of db.prepare(`SELECT id, to_addr, subject, gmail_thread_id, sent_at, updated_at FROM email_drafts WHERE status='sent' AND COALESCE(sent_at, updated_at) >= ?`).all(d.created_at) as any[])
      later.push({ ...conv(r, r.sent_at || r.updated_at), kind: "sent" as const });
    for (const r of db.prepare(`SELECT id, from_address, subject, created_at FROM inbound_emails WHERE created_at >= ?`).all(d.created_at) as any[])
      later.push({ id: r.id, address: bareAddress(r.from_address), subject: r.subject || "", thread: null, at: r.created_at, kind: "inbound" as const });
    const why = staleEmailReasons(pending, later).get(id);
    if (why) throw new Error(`Can't put this back: ${why}. It would be retired again right away.`);
    db.prepare(`UPDATE email_drafts SET status='pending_approval', error=NULL, updated_at=datetime('now') WHERE id=? AND status='superseded'`).run(id);
    label = `email draft #${id}`;
  } else if (input.kind === "text") {
    const d = db.prepare(`SELECT id, to_handle, chat_guid, status FROM text_drafts WHERE id=?`).get(id) as any;
    if (!d) throw new Error(`Text draft ${id} not found`);
    if (d.status !== "superseded") throw new Error(`Text draft ${id} is ${d.status}, not retired; nothing to restore`);
    const key = (r: any) => ({ id: r.id as number, key: textKey(r.to_handle, r.chat_guid) });
    const pending = [d, ...(db.prepare(`SELECT id, to_handle, chat_guid FROM text_drafts WHERE status='pending_approval'`).all() as any[])].map(key);
    const sent = (db.prepare(`SELECT id, to_handle, chat_guid FROM text_drafts WHERE status='sent' AND id > ?`).all(id) as any[]).map(key);
    const why = staleTextReasons(pending, sent).get(id);
    if (why) throw new Error(`Can't put this back: ${why}. It would be retired again right away.`);
    db.prepare(`UPDATE text_drafts SET status='pending_approval' WHERE id=? AND status='superseded'`).run(id);
    label = `text draft #${id}`;
  } else if (input.kind === "calendar") {
    const d = db.prepare(`SELECT id, date, end, status FROM schedule_items WHERE id=?`).get(id) as any;
    if (!d) throw new Error(`Calendar proposal ${id} not found`);
    if (d.status !== "superseded" && d.status !== "expired") throw new Error(`Calendar proposal ${id} is ${d.status}, not retired; nothing to restore`);
    if (hasEnded(d.end, d.date, Date.now(), centralDateKey())) throw new Error("Can't put this back: its end time has already passed.");
    db.prepare(`UPDATE schedule_items SET status='proposed' WHERE id=? AND status IN ('superseded','expired')`).run(id);
    label = `calendar proposal #${id}`;
  } else {
    throw new Error(`Unknown kind "${input.kind}" (use email, text or calendar)`);
  }
  try { logActivity(by, "proposal_lifecycle", `Restored ${label} to waiting for approval.`); } catch { /* audit is best-effort */ }
  return { kind: input.kind, id, status: input.kind === "calendar" ? "proposed" : "pending_approval" };
}
