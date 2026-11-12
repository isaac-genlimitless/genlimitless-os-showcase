import db from "./db";
import { listEmailDrafts } from "./email-drafts";
import { listApprovalRequests } from "./agents/registry";
import { autopilotSuggestions, isPaused, listScheduledSends, listTrust, recentSends, singleEmail, textRecipient } from "./autopilot";
import { centralDateKey } from "./time";
import { sweepProposals } from "./proposal-lifecycle";

// ONE queue of everything waiting on Owner, so his daily job is a couple of minutes of yes/no.
// Read-only aggregation: every action button calls the existing route that already owns that
// decision (email-drafts, text-drafts, schedule-items, agents decide_approval, autopilot).

export type DecisionItem = {
  key: string; // "<kind>:<id>"
  kind: "email_draft" | "text_draft" | "approval" | "schedule_item" | "code_change";
  id: number;
  title: string;
  detail: string;
  created_at: string;
  autopilot_send_at?: string; // set when Autopilot will send it unless held
  autopilot_send_id?: number;
  autopilot_eligible?: { kind: "email" | "text"; recipient: string; label: string }; // can be put on Autopilot
  link?: string; // where the full review lives, for kinds approved elsewhere
};

const snip = (s: string | null | undefined, n = 220) => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function listDecisions(): { items: DecisionItem[]; counts: Record<string, number> } {
  sweepProposals(); // marks ended calendar blocks 'expired' and stale email/text drafts 'superseded' (status only, never deletes; never throws)
  const scheduled = new Map(listScheduledSends().map((s) => [`${s.kind}:${s.draft_id}`, s]));
  const items: DecisionItem[] = [];

  for (const d of listEmailDrafts("pending_approval", 100)) {
    const s = scheduled.get(`email:${d.id}`);
    const r = singleEmail(d.to_addr);
    items.push({
      key: `email_draft:${d.id}`,
      kind: "email_draft",
      id: d.id,
      title: `Email to ${d.to_addr}${d.subject ? `: ${d.subject}` : ""}`,
      detail: snip(d.body),
      created_at: d.created_at,
      ...(s ? { autopilot_send_at: s.send_at, autopilot_send_id: s.id } : {}),
      ...(r ? { autopilot_eligible: { kind: "email" as const, recipient: r, label: d.to_addr } } : {}),
    });
  }

  const texts = db.prepare(`SELECT * FROM text_drafts WHERE status='pending_approval' ORDER BY id DESC LIMIT 100`).all() as {
    id: number; to_handle: string | null; chat_guid: string | null; contact_name: string | null; text: string; reason: string | null; created_at: string;
  }[];
  for (const t of texts) {
    const s = scheduled.get(`text:${t.id}`);
    const r = textRecipient(t);
    const who = t.contact_name || t.to_handle || "a group chat";
    items.push({
      key: `text_draft:${t.id}`,
      kind: "text_draft",
      id: t.id,
      title: `Text to ${who}`,
      detail: snip(t.text),
      created_at: t.created_at,
      ...(s ? { autopilot_send_at: s.send_at, autopilot_send_id: s.id } : {}),
      ...(r ? { autopilot_eligible: { kind: "text" as const, recipient: r, label: who } } : {}),
    });
  }

  for (const a of listApprovalRequests("pending")) {
    items.push({ key: `approval:${a.id}`, kind: "approval", id: a.id, title: a.title, detail: snip(a.reason), created_at: a.created_at });
  }

  const today = centralDateKey();
  const proposed = db.prepare(`SELECT * FROM schedule_items WHERE status='proposed' AND date >= ? ORDER BY start ASC LIMIT 50`).all(today) as {
    id: number; date: string; title: string; start: string; end: string; reason: string | null; created_at: string;
  }[];
  for (const p of proposed) {
    items.push({ key: `schedule_item:${p.id}`, kind: "schedule_item", id: p.id, title: `Calendar block: ${p.title}`, detail: `${p.start} → ${p.end}${p.reason ? ` · ${snip(p.reason, 160)}` : ""}`, created_at: p.created_at });
  }

  try {
    const fixes = db.prepare(`SELECT id, title, created_at FROM fix_proposals WHERE status='pending_approval' ORDER BY id DESC LIMIT 30`).all() as { id: number; title: string; created_at: string }[];
    for (const f of fixes) items.push({ key: `code_change:${f.id}`, kind: "code_change", id: f.id, title: `Code change: ${f.title}`, detail: "Reviewed by Chief; needs your sign-off.", created_at: f.created_at, link: "/analytics" });
  } catch {
    /* fix_proposals not created yet */
  }


  // Soonest Autopilot sends first (they're on a clock), then oldest first: nothing rots at the bottom.
  items.sort((a, b) => {
    if (!!a.autopilot_send_at !== !!b.autopilot_send_at) return a.autopilot_send_at ? -1 : 1;
    if (a.autopilot_send_at && b.autopilot_send_at) return a.autopilot_send_at.localeCompare(b.autopilot_send_at);
    return a.created_at.localeCompare(b.created_at);
  });
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] || 0) + 1;
  return { items, counts };
}

export function autopilotPanel() {
  return { paused: isPaused(), trusted: listTrust(true), suggestions: autopilotSuggestions(), scheduled: listScheduledSends(), recent: recentSends(10) };
}
