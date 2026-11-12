import db from "./db";
import { centralDateKey } from "./time";
import { logActivity } from "./agents/registry";
import { bareAddress, hasEnded, staleEmailReasons, staleTextReasons, textKey, Conv } from "./proposal-lifecycle-core";

// Retires stale proposals by STATUS only ('expired' / 'superseded'). Nothing is deleted or sent.
export type Kind = "email" | "text" | "calendar";
const note = (who: string, text: string) => { try { logActivity(who, "proposal_lifecycle", text); } catch { /* audit is best-effort */ } };

export function expirePastCalendar(now = new Date()): number {
  const today = centralDateKey(now);
  const rows = db.prepare(`SELECT id, date, title, end FROM schedule_items WHERE status='proposed'`).all() as { id: number; date: string; title: string; end: string }[];
  let n = 0;
  for (const r of rows) {
    if (!hasEnded(r.end, r.date, now.getTime(), today)) continue;
    if (db.prepare(`UPDATE schedule_items SET status='expired' WHERE id=? AND status='proposed'`).run(r.id).changes) {
      n++; note("system", `Calendar proposal #${r.id} "${r.title}" expired: its end time (${r.end}) passed.`);
    }
  }
  return n;
}

export function supersedeStaleEmails(): number {
  const p = db.prepare(`SELECT id, to_addr, subject, gmail_thread_id, in_reply_to, created_at FROM email_drafts WHERE status='pending_approval'`).all() as any[];
  if (!p.length) return 0;
  const conv = (r: any, at: string): Conv => ({ id: r.id, address: bareAddress(r.to_addr), subject: r.subject || "", thread: r.gmail_thread_id, at });
  const pending = p.map((r) => ({ ...conv(r, r.created_at), isReply: !!r.in_reply_to || /^\s*re\s*:/i.test(r.subject || "") }));
  const oldest = pending.map((d) => d.at).sort()[0];
  const later: any[] = pending.map((d) => ({ ...d, kind: "draft" as const }));
  for (const r of db.prepare(`SELECT id, to_addr, subject, gmail_thread_id, sent_at, updated_at FROM email_drafts WHERE status='sent' AND COALESCE(sent_at, updated_at) >= ?`).all(oldest) as any[])
    later.push({ ...conv(r, r.sent_at || r.updated_at), kind: "sent" as const });
  for (const r of db.prepare(`SELECT id, from_address, subject, created_at FROM inbound_emails WHERE created_at >= ?`).all(oldest) as any[])
    later.push({ id: r.id, address: bareAddress(r.from_address), subject: r.subject || "", thread: null, at: r.created_at, kind: "inbound" as const });
  let n = 0;
  for (const [id, why] of staleEmailReasons(pending, later)) {
    if (db.prepare(`UPDATE email_drafts SET status='superseded', error=?, updated_at=datetime('now') WHERE id=? AND status='pending_approval'`).run(`Superseded: ${why}`, id).changes) {
      n++; note("system", `Email draft #${id} superseded: ${why}.`);
    }
  }
  return n;
}

export function supersedeStaleTexts(): number {
  const key = (r: any) => ({ id: r.id as number, key: textKey(r.to_handle, r.chat_guid) });
  const pending = (db.prepare(`SELECT id, to_handle, chat_guid FROM text_drafts WHERE status='pending_approval'`).all() as any[]).map(key);
  if (!pending.length) return 0;
  const sent = (db.prepare(`SELECT id, to_handle, chat_guid FROM text_drafts WHERE status='sent' AND id > ?`).all(Math.min(...pending.map((x) => x.id))) as any[]).map(key);
  let n = 0;
  for (const [id, why] of staleTextReasons(pending, sent)) {
    if (db.prepare(`UPDATE text_drafts SET status='superseded', reason=COALESCE(reason,'') || ' [Superseded: ' || ? || ']' WHERE id=? AND status='pending_approval'`).run(why, id).changes) {
      n++; note("system", `Text draft #${id} superseded: ${why}.`);
    }
  }
  return n;
}

/** Everything /decisions should no longer show. Never throws. */
export function sweepProposals(now = new Date()) {
  const out = { expired: 0, emails: 0, texts: 0 };
  try { out.expired = expirePastCalendar(now); } catch (e) { console.error("sweep calendar", e); }
  try { out.emails = supersedeStaleEmails(); } catch (e) { console.error("sweep emails", e); }
  try { out.texts = supersedeStaleTexts(); } catch (e) { console.error("sweep texts", e); }
  return out;
}

/** Agent-facing cancel (tool wired in part 3). Status change + logged reason; never deletes. */
export function supersedeProposal(input: { kind: Kind; id: number; reason: string; by: string }) {
  const reason = (input.reason || "").trim();
  if (reason.length < 5) throw new Error("reason is required (say why this proposal is no longer wanted)");
  const isCos = input.by === "chief_of_staff";
  const id = Number(input.id);
  if (input.kind === "email") {
    const d = db.prepare(`SELECT status, created_by FROM email_drafts WHERE id=?`).get(id) as any;
    if (!d) throw new Error(`Email draft ${id} not found`);
    if (d.status !== "pending_approval") throw new Error(`Email draft ${id} is ${d.status}; only pending drafts can be superseded`);
    if (!isCos && d.created_by !== input.by) throw new Error(`Email draft ${id} was written by ${d.created_by}, not you. Ask them or the Chief of Staff.`);
    db.prepare(`UPDATE email_drafts SET status='superseded', error=?, updated_at=datetime('now') WHERE id=? AND status='pending_approval'`).run(`Superseded by ${input.by}: ${reason}`, id);
  } else {
    const table = input.kind === "text" ? "text_drafts" : "schedule_items";
    const open = input.kind === "text" ? "pending_approval" : "proposed";
    if (!isCos) throw new Error(`${input.kind === "text" ? "Text drafts" : "Calendar proposals"} do not record their author, so only the Chief of Staff can supersede them. Ask the Chief of Staff.`);
    const d = db.prepare(`SELECT status FROM ${table} WHERE id=?`).get(id) as any;
    if (!d) throw new Error(`${input.kind} proposal ${id} not found`);
    if (d.status !== open) throw new Error(`${input.kind} proposal ${id} is ${d.status}; only ${open} items can be superseded`);
    db.prepare(`UPDATE ${table} SET status='superseded', reason=COALESCE(reason,'') || ' [Superseded by ' || ? || ': ' || ? || ']' WHERE id=? AND status=?`).run(input.by, reason, id, open);
  }
  note(input.by, `Superseded ${input.kind} proposal #${id}: ${reason}`);
  return { kind: input.kind, id, status: "superseded", reason };
}
