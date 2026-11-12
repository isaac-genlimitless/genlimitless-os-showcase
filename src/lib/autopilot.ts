import { ownerName } from "./instance";
import crypto from "crypto";
import db, { getState, logIssue, setState, snapshotBeforeNewTables } from "./db";
import { centralParts, centralToIso, fmtCentral, toSqliteUtc } from "./time";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// AUTOPILOT: earned autonomy, switched on by Owner one recipient at a time.
//
// Agents still only ever DRAFT. What changes is what happens to a draft for a recipient Owner has
// put on Autopilot: instead of waiting for his click forever, it is scheduled to send after a hold
// window (default 30 min). Until then it's an ordinary pending draft he can edit, send now, or Hold.
//
// Hard rules (enforced here, in code, not by any prompt):
//  - Only Owner turns a recipient on (the /api/autopilot route; no agent tool can). Agents can only
//    READ suggestions so Chief can propose a promotion.
//  - One recipient exactly. Group texts, several To addresses, or any change of recipient => manual.
//  - Rechecked at send time: trust still on, draft still pending and unchanged (an edit restarts the
//    hold window), global pause off, daily caps, and only between 7am and 9pm Central.
//  - Everything stays in the record: nothing here deletes a row.

snapshotBeforeNewTables("autopilot", ["autopilot_trust", "autopilot_events", "autopilot_sends"]);
db.exec(`
CREATE TABLE IF NOT EXISTS autopilot_trust (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('email','text')),
  recipient TEXT NOT NULL,            -- normalized: lowercase email, or phone digits
  label TEXT,                         -- how Owner sees it ("Partner", "Mom <mom@x.com>")
  delay_min INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'active', -- active | off | declined (a suggestion he said no to)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, recipient)
);
CREATE TABLE IF NOT EXISTS autopilot_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  recipient TEXT NOT NULL,
  label TEXT,
  draft_id INTEGER,
  outcome TEXT NOT NULL,              -- approved_unchanged | approved_edited | rejected | auto_sent | held
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_autopilot_events_r ON autopilot_events(kind, recipient, id);
CREATE TABLE IF NOT EXISTS autopilot_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  draft_id INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  label TEXT,
  body_hash TEXT NOT NULL,
  send_at TEXT NOT NULL,              -- SQLite UTC
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | sent | held | skipped | failed
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  UNIQUE(kind, draft_id)
);
`);

export type Kind = "email" | "text";
export const DAILY_CAP = 10; // auto-sends across everyone per rolling 24h
export const PER_RECIPIENT_DAILY_CAP = 3;
export const SUGGEST_AFTER = 5; // unchanged approvals in a row before Chief suggests Autopilot
const SEND_FROM_HOUR = 7;
const SEND_UNTIL_HOUR = 21;
const PAUSE_KEY = "autopilot_paused";

export type TrustRow = { id: number; kind: Kind; recipient: string; label: string | null; delay_min: number; status: "active" | "off" | "declined"; created_at: string; updated_at: string };
export type SendRow = { id: number; kind: Kind; draft_id: number; recipient: string; label: string | null; body_hash: string; send_at: string; status: string; note: string | null; created_at: string; decided_at: string | null };

// ---------------------------------------------------------------- recipients

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** The single email address in a To field, or null if there are zero or several. */
export function singleEmail(to: string | null | undefined): string | null {
  const found = [...new Set((to || "").match(EMAIL_RE)?.map((e) => e.toLowerCase()) || [])];
  return found.length === 1 ? found[0] : null;
}

/** Phone digits (US numbers without the leading 1) or a lowercase email handle. */
export function normalizeTextHandle(h: string | null | undefined): string | null {
  const s = (h || "").trim();
  if (!s) return null;
  if (s.includes("@")) return s.toLowerCase();
  let d = s.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length >= 7 ? d : null;
}

/** 1:1 chat guids end in the other person's handle ("any;-;+18015551234"); group chats ("any;+;...") don't. */
export function textRecipient(d: { to_handle?: string | null; chat_guid?: string | null }): string | null {
  if (d.chat_guid && !d.chat_guid.includes(";-;")) return null; // group chat: never on Autopilot
  return normalizeTextHandle(d.to_handle || (d.chat_guid ? d.chat_guid.split(";-;")[1] : null));
}

export function normalizeRecipient(kind: Kind, raw: string): string | null {
  return kind === "email" ? singleEmail(raw) : normalizeTextHandle(raw);
}

const hash = (s: string) => crypto.createHash("sha256").update(s.trim()).digest("hex").slice(0, 16);

// ---------------------------------------------------------------- trust (Owner only)

export function listTrust(includeOff = false): TrustRow[] {
  return db.prepare(`SELECT * FROM autopilot_trust ${includeOff ? "WHERE status != 'declined'" : "WHERE status='active'"} ORDER BY label COLLATE NOCASE, id`).all() as TrustRow[];
}

function trustFor(kind: Kind, recipient: string): TrustRow | undefined {
  return db.prepare(`SELECT * FROM autopilot_trust WHERE kind=? AND recipient=?`).get(kind, recipient) as TrustRow | undefined;
}

/** Owner turns a recipient on (from the Decisions page). Re-enabling an 'off' row reuses it. */
export function turnOnAutopilot(input: { kind: Kind; recipient: string; label?: string; delay_min?: number }): TrustRow {
  if (input.kind !== "email" && input.kind !== "text") throw new Error("kind must be email or text");
  const recipient = normalizeRecipient(input.kind, input.recipient);
  if (!recipient) throw new Error(input.kind === "email" ? "Give exactly one email address" : "Give one phone number or iMessage email");
  const delay = Math.round(Number(input.delay_min ?? 30));
  if (!Number.isFinite(delay) || delay < 5 || delay > 24 * 60) throw new Error("delay_min must be between 5 and 1440 minutes");
  db.prepare(
    `INSERT INTO autopilot_trust (kind, recipient, label, delay_min, status) VALUES (?, ?, ?, ?, 'active')
     ON CONFLICT(kind, recipient) DO UPDATE SET status='active', delay_min=excluded.delay_min, label=COALESCE(excluded.label, autopilot_trust.label), updated_at=datetime('now')`
  ).run(input.kind, recipient, input.label?.trim() || input.recipient.trim(), delay);
  return trustFor(input.kind, recipient)!;
}

/** Soft: the row stays (status 'off'); anything already scheduled for them is held. */
export function turnOffAutopilot(id: number): TrustRow {
  const t = db.prepare(`SELECT * FROM autopilot_trust WHERE id=?`).get(id) as TrustRow | undefined;
  if (!t) throw new Error("Autopilot entry not found");
  db.prepare(`UPDATE autopilot_trust SET status='off', updated_at=datetime('now') WHERE id=?`).run(id);
  db.prepare(`UPDATE autopilot_sends SET status='held', note='Autopilot turned off for this person', decided_at=datetime('now') WHERE kind=? AND recipient=? AND status='scheduled'`).run(t.kind, t.recipient);
  return { ...t, status: "off" };
}

/** "Not now" on a suggestion: remembered so Chief doesn't re-suggest it for 30 days. */
export function declineSuggestion(kind: Kind, recipient: string, label?: string) {
  const r = normalizeRecipient(kind, recipient) || recipient;
  db.prepare(
    `INSERT INTO autopilot_trust (kind, recipient, label, status) VALUES (?, ?, ?, 'declined')
     ON CONFLICT(kind, recipient) DO UPDATE SET status=CASE WHEN autopilot_trust.status='active' THEN 'active' ELSE 'declined' END, updated_at=datetime('now')`
  ).run(kind, r, label || recipient);
  return { ok: true };
}

export function isPaused(): boolean {
  return getState(PAUSE_KEY) === "1";
}
export function setPaused(on: boolean) {
  setState(PAUSE_KEY, on ? "1" : "0");
  return { paused: on };
}

// ---------------------------------------------------------------- learning signal

export function recordDecision(kind: Kind, rawRecipient: string | null, draftId: number, outcome: "approved_unchanged" | "approved_edited" | "rejected", label?: string | null) {
  try {
    const recipient = rawRecipient ? (kind === "email" ? singleEmail(rawRecipient) : normalizeTextHandle(rawRecipient)) : null;
    if (!recipient) return;
    db.prepare(`INSERT INTO autopilot_events (kind, recipient, label, draft_id, outcome) VALUES (?, ?, ?, ?, ?)`).run(kind, recipient, label || rawRecipient, draftId, outcome);
    // Owner acted on the draft himself: any Autopilot countdown for it is moot.
    db.prepare(`UPDATE autopilot_sends SET status='skipped', note=?, decided_at=datetime('now') WHERE kind=? AND draft_id=? AND status='scheduled'`).run(
      outcome === "rejected" ? `${ownerName()} discarded the draft` : `${ownerName()} sent it themself`,
      kind,
      draftId
    );
  } catch (err) {
    logIssue("autopilot", "Couldn't record an approval decision", errMsg(err));
  }
}

export type Suggestion = { kind: Kind; recipient: string; label: string; approved_in_a_row: number };

/** Recipients whose last SUGGEST_AFTER+ decisions were all "approved without a change", not already on
 *  Autopilot and not declined in the last 30 days. Computed in code; Chief only reads it. */
export function autopilotSuggestions(): Suggestion[] {
  const recips = db
    .prepare(`SELECT kind, recipient, MAX(id) last FROM autopilot_events WHERE outcome != 'auto_sent' AND at > datetime('now','-90 days') GROUP BY kind, recipient`)
    .all() as { kind: Kind; recipient: string }[];
  const out: Suggestion[] = [];
  for (const r of recips) {
    const t = trustFor(r.kind, r.recipient);
    if (t?.status === "active" || t?.status === "off") continue; // he's already decided this one
    if (t?.status === "declined" && Date.parse(t.updated_at + "Z") > Date.now() - 30 * 86400e3) continue;
    const ev = db
      .prepare(`SELECT outcome, label FROM autopilot_events WHERE kind=? AND recipient=? AND outcome IN ('approved_unchanged','approved_edited','rejected','held') ORDER BY id DESC LIMIT 20`)
      .all(r.kind, r.recipient) as { outcome: string; label: string | null }[];
    let streak = 0;
    for (const e of ev) {
      if (e.outcome !== "approved_unchanged") break;
      streak++;
    }
    if (streak >= SUGGEST_AFTER) out.push({ kind: r.kind, recipient: r.recipient, label: ev[0]?.label || r.recipient, approved_in_a_row: streak });
  }
  return out.sort((a, b) => b.approved_in_a_row - a.approved_in_a_row);
}

// ---------------------------------------------------------------- scheduling

/** Next instant inside the 7am-9pm Central sending window at or after `t`. */
export function inSendingWindow(t: Date): Date {
  const p = centralParts(t);
  if (p.hour24 >= SEND_FROM_HOUR && p.hour24 < SEND_UNTIL_HOUR) return t;
  if (p.hour24 < SEND_FROM_HOUR) return new Date(centralToIso(p.date, SEND_FROM_HOUR, 0));
  const tomorrow = new Date(Date.parse(p.date + "T12:00:00Z") + 86400e3).toISOString().slice(0, 10);
  return new Date(centralToIso(tomorrow, SEND_FROM_HOUR, 0));
}

/** Called right after a draft is created. Schedules an Autopilot send if (and only if) its single
 *  recipient is on Autopilot. Returns the send row, or null for "normal manual review". Never throws. */
export function maybeScheduleAutopilot(kind: Kind, draft: { id: number; recipient: string | null; label?: string | null; body: string }, now = new Date()): SendRow | null {
  try {
    if (!draft.recipient || isPaused()) return null;
    const t = trustFor(kind, draft.recipient);
    if (!t || t.status !== "active") return null;
    const at = inSendingWindow(new Date(now.getTime() + t.delay_min * 60_000));
    db.prepare(
      `INSERT INTO autopilot_sends (kind, draft_id, recipient, label, body_hash, send_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, draft_id) DO NOTHING`
    ).run(kind, draft.id, draft.recipient, t.label || draft.label || draft.recipient, hash(draft.body), toSqliteUtc(at));
    const row = db.prepare(`SELECT * FROM autopilot_sends WHERE kind=? AND draft_id=?`).get(kind, draft.id) as SendRow;
    db.prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant', ?)`).run(
      `**Autopilot:** the ${kind === "email" ? "email" : "text"} to ${row.label} goes out at ${fmtCentral(at, { hour: "numeric", minute: "2-digit" })} unless you hold or change it. [Decisions](/decisions)`
    );
    return row;
  } catch (err) {
    logIssue("autopilot", "Couldn't schedule an Autopilot send (left for manual review)", errMsg(err));
    return null;
  }
}

export function listScheduledSends(): SendRow[] {
  return db.prepare(`SELECT * FROM autopilot_sends WHERE status='scheduled' ORDER BY send_at ASC`).all() as SendRow[];
}

export function recentSends(limit = 20): SendRow[] {
  return db.prepare(`SELECT * FROM autopilot_sends WHERE status != 'scheduled' ORDER BY id DESC LIMIT ?`).all(limit) as SendRow[];
}

/** Owner's Hold: the draft goes back to normal manual review. */
export function holdSend(id: number): SendRow {
  const s = db.prepare(`SELECT * FROM autopilot_sends WHERE id=?`).get(id) as SendRow | undefined;
  if (!s) throw new Error("Scheduled send not found");
  if (s.status !== "scheduled") throw new Error(`Already ${s.status}`);
  db.prepare(`UPDATE autopilot_sends SET status='held', note='Held by Owner', decided_at=datetime('now') WHERE id=?`).run(id);
  db.prepare(`INSERT INTO autopilot_events (kind, recipient, label, draft_id, outcome) VALUES (?, ?, ?, ?, 'held')`).run(s.kind, s.recipient, s.label, s.draft_id);
  return { ...s, status: "held" };
}

// ---------------------------------------------------------------- the tick

type DraftView = { status: string; recipient: string | null; body: string };
export type TickDeps = {
  now?: () => Date;
  loadDraft?: (kind: Kind, id: number) => DraftView | null;
  send?: (kind: Kind, id: number) => Promise<unknown>;
};

async function defaultLoadDraft(kind: Kind, id: number): Promise<DraftView | null> {
  if (kind === "email") {
    const { getEmailDraft } = await import("./email-drafts");
    const d = getEmailDraft(id);
    return d ? { status: d.status, recipient: singleEmail(d.to_addr), body: `${d.to_addr}\n${d.subject}\n${d.body}` } : null;
  }
  const { getTextDraft } = await import("./text-drafts");
  const d = getTextDraft(id);
  return d ? { status: d.status, recipient: textRecipient(d), body: d.text } : null;
}

async function defaultSend(kind: Kind, id: number) {
  if (kind === "email") return (await import("./email-drafts")).approveEmailDraft(id, undefined, { by: "autopilot" });
  return (await import("./text-drafts")).approveTextDraft(id, undefined, { by: "autopilot" });
}

const sentInLastDay = (recipient?: string) =>
  (
    (recipient
      ? db.prepare(`SELECT COUNT(*) c FROM autopilot_sends WHERE status='sent' AND recipient=? AND decided_at > datetime('now','-1 day')`).get(recipient)
      : db.prepare(`SELECT COUNT(*) c FROM autopilot_sends WHERE status='sent' AND decided_at > datetime('now','-1 day')`).get()) as { c: number }
  ).c;

let ticking = false;
/** Every minute: send what's due, after rechecking every rule. */
export async function runAutopilotTick(deps: TickDeps = {}): Promise<{ sent: number; held: number; rescheduled: number }> {
  const res = { sent: 0, held: 0, rescheduled: 0 };
  if (ticking) return res;
  ticking = true;
  const now = (deps.now ?? (() => new Date()))();
  const load = deps.loadDraft ?? ((k: Kind, id: number) => defaultLoadDraft(k, id));
  const send = deps.send ?? defaultSend;
  const settle = (id: number, status: string, note: string) =>
    db.prepare(`UPDATE autopilot_sends SET status=?, note=?, decided_at=datetime('now') WHERE id=? AND status='scheduled'`).run(status, note, id);
  try {
    if (isPaused()) return res;
    const due = db.prepare(`SELECT * FROM autopilot_sends WHERE status='scheduled' AND send_at <= ? ORDER BY send_at ASC LIMIT 10`).all(toSqliteUtc(now)) as SendRow[];
    for (const s of due) {
      const d = await load(s.kind, s.draft_id);
      if (!d || d.status !== "pending_approval") {
        settle(s.id, "skipped", d ? `Draft is ${d.status}` : "Draft not found");
        continue;
      }
      const t = trustFor(s.kind, s.recipient);
      if (!t || t.status !== "active") {
        settle(s.id, "held", "Autopilot no longer on for this person");
        res.held++;
        continue;
      }
      if (d.recipient !== s.recipient) {
        settle(s.id, "held", "Recipient changed after scheduling; needs Owner");
        res.held++;
        continue;
      }
      if (hash(d.body) !== s.body_hash) {
        // Edited after scheduling: Owner gets a full hold window on the final wording.
        const at = inSendingWindow(new Date(now.getTime() + t.delay_min * 60_000));
        db.prepare(`UPDATE autopilot_sends SET body_hash=?, send_at=?, note='Draft changed; hold window restarted' WHERE id=?`).run(hash(d.body), toSqliteUtc(at), s.id);
        res.rescheduled++;
        continue;
      }
      const windowed = inSendingWindow(now);
      if (windowed.getTime() !== now.getTime()) {
        db.prepare(`UPDATE autopilot_sends SET send_at=?, note='Waiting for 7am Central' WHERE id=?`).run(toSqliteUtc(windowed), s.id);
        res.rescheduled++;
        continue;
      }
      if (sentInLastDay() >= DAILY_CAP || sentInLastDay(s.recipient) >= PER_RECIPIENT_DAILY_CAP) {
        settle(s.id, "held", "Daily Autopilot limit reached; needs Owner");
        res.held++;
        continue;
      }
      // Claim it before sending so an overlapping tick can't send twice.
      const claimed = db.prepare(`UPDATE autopilot_sends SET status='sending' WHERE id=? AND status='scheduled'`).run(s.id).changes;
      if (!claimed) continue;
      try {
        await send(s.kind, s.draft_id);
        db.prepare(`UPDATE autopilot_sends SET status='sent', note='Sent by Autopilot', decided_at=datetime('now') WHERE id=?`).run(s.id);
        db.prepare(`INSERT INTO autopilot_events (kind, recipient, label, draft_id, outcome) VALUES (?, ?, ?, ?, 'auto_sent')`).run(s.kind, s.recipient, s.label, s.draft_id);
        res.sent++;
      } catch (err) {
        db.prepare(`UPDATE autopilot_sends SET status='failed', note=?, decided_at=datetime('now') WHERE id=?`).run(`Send failed: ${errMsg(err).slice(0, 300)}`, s.id);
        logIssue("autopilot", `Autopilot send failed (${s.kind} draft ${s.draft_id}); it's back in manual review`, errMsg(err));
      }
    }
  } finally {
    ticking = false;
  }
  return res;
}
