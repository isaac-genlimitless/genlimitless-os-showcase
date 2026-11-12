import db from "../db";
import { OWNER, isAgentActor, roleOf } from "./store";

// Execution: turning canon into real-world steps. A step is only a PLAN until Owner approves it, and
// approving hands it to the part of the OS that already owns that kind of action, which keeps its own
// safety rules:
//   task    → a task in Tasks (internal, nothing leaves the OS)
//   email   → an email DRAFT in Communications → Email (Owner still presses send there; Autopilot
//             recipients follow his existing Autopilot rule)
//   meeting → a calendar_create request in the approval queue (no invite goes out until he approves it there)
//   manual  → something Owner or Partner does by hand (a call, a site visit); marked done when it's done
// Nothing is deleted: steps are declined, failed or done.

export const STEP_KINDS = ["task", "email", "meeting", "manual"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export interface Step {
  id: number; creation_id: number; version_id: number | null; kind: StepKind; title: string; details: string;
  payload: Record<string, unknown> | null; status: "proposed" | "approved" | "done" | "declined" | "failed";
  result: string | null; sort_order: number; created_by: string; decided_by: string | null;
  created_at: string; decided_at: string | null; done_at: string | null;
}

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?([+-]\d\d:\d\d|Z)?$/;
const DATE_RE = /^\d{4}-\d\d-\d\d$/;

function fail(msg: string): never {
  throw new Error(msg);
}
const txt = (v: unknown, name: string, max: number, required = false) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) fail(`${name} is required`);
  if (s.length > max) fail(`${name} is too long (max ${max})`);
  return s;
};

function creationOf(slug: string): { id: number; canon_version_id: number } {
  const c = db.prepare(`SELECT id, canon_version_id FROM creations WHERE slug = ? AND status = 'active'`).get(slug) as { id: number; canon_version_id: number } | undefined;
  if (!c) fail("creation not found");
  return c;
}

const toStep = (r: Omit<Step, "payload"> & { payload: string | null }): Step => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null });

export function getStep(id: number): Step {
  const r = db.prepare(`SELECT * FROM creation_exec_steps WHERE id = ?`).get(id) as (Omit<Step, "payload"> & { payload: string | null }) | undefined;
  if (!r) fail("step not found");
  return toStep(r);
}

export function listSteps(slug: string, actor = OWNER): Step[] {
  const c = creationOf(slug);
  if (!roleOf(c.id, actor)) fail("creation not found");
  return (db.prepare(`SELECT * FROM creation_exec_steps WHERE creation_id = ? ORDER BY sort_order, id`).all(c.id) as (Omit<Step, "payload"> & { payload: string | null })[]).map(toStep);
}

/** Validates a step's kind-specific fields. Returns the clean payload. */
export function normalizeStep(input: Record<string, unknown>): { kind: StepKind; title: string; details: string; payload: Record<string, unknown> | null } {
  const kind = input.kind as StepKind;
  if (!STEP_KINDS.includes(kind)) fail(`kind must be one of ${STEP_KINDS.join(", ")}`);
  const title = txt(input.title, "title", 200, true);
  const details = txt(input.details, "details", 8000);
  const p = (input.payload && typeof input.payload === "object" ? input.payload : {}) as Record<string, unknown>;
  if (kind === "email") {
    const to = txt(p.to, "email to", 300, true);
    if (!to.split(",").every((x) => EMAIL_RE.test(x.trim()))) fail("email to must be email address(es)");
    return { kind, title, details, payload: { to, subject: txt(p.subject, "subject", 300, true), body: txt(p.body, "email body", 20000, true), ...(p.account ? { account: txt(p.account, "account", 200) } : {}) } };
  }
  if (kind === "meeting") {
    const start = txt(p.start, "meeting start", 40, true);
    const end = txt(p.end, "meeting end", 40, true);
    if (!ISO_RE.test(start) || !ISO_RE.test(end)) fail("meeting start/end must be date-times like 2026-11-12T10:00:00-06:00");
    if (Date.parse(end) <= Date.parse(start)) fail("meeting end must be after start");
    const attendees = (Array.isArray(p.attendees) ? p.attendees : typeof p.attendees === "string" ? p.attendees.split(",") : []).map((a) => String(a).trim()).filter(Boolean);
    if (!attendees.every((a) => EMAIL_RE.test(a))) fail("attendees must be email addresses");
    return { kind, title, details, payload: { start, end, attendees } };
  }
  if (kind === "task") {
    const due = txt(p.due_date, "due date", 10);
    if (due && !DATE_RE.test(due)) fail("due date must be YYYY-MM-DD");
    const priority = p.priority === "high" || p.priority === "low" ? p.priority : "normal";
    return { kind, title, details, payload: { ...(due ? { due_date: due } : {}), priority } };
  }
  return { kind, title, details, payload: null };
}

/** Owner, collaborators, and the Producer agent can propose steps. Proposing does nothing outside this table. */
export function proposeStep(slug: string, input: Record<string, unknown>, actor = OWNER): Step {
  const c = creationOf(slug);
  if (actor !== "agent:producer") {
    const role = roleOf(c.id, actor);
    if (!role) fail("creation not found");
    if (role === "viewer") fail("viewers can't propose steps");
  }
  const s = normalizeStep(input);
  const order = (db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM creation_exec_steps WHERE creation_id = ?`).get(c.id) as { n: number }).n;
  const info = db.prepare(`INSERT INTO creation_exec_steps (creation_id, version_id, kind, title, details, payload, sort_order, created_by) VALUES (?,?,?,?,?,?,?,?)`)
    .run(c.id, c.canon_version_id, s.kind, s.title, s.details, s.payload ? JSON.stringify(s.payload) : null, order, actor);
  db.prepare(`INSERT INTO creation_feed (creation_id, kind, title, actor, resolved_at) VALUES (?, 'step', ?, ?, datetime('now'))`).run(c.id, `Step proposed: ${s.title}`, actor);
  return getStep(Number(info.lastInsertRowid));
}

/** Edit a step while it's still a proposal (owner, or whoever proposed it). */
export function editStep(id: number, input: Record<string, unknown>, actor = OWNER): Step {
  const st = getStep(id);
  const role = roleOf(st.creation_id, actor);
  if (role !== "owner" && st.created_by !== actor) fail("only the owner or whoever proposed it can edit a step");
  if (st.status !== "proposed" && st.status !== "failed") fail(`that step is already ${st.status}`);
  const given = Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && k !== "kind"));
  const s = normalizeStep({ kind: st.kind, title: st.title, details: st.details, payload: st.payload, ...given });
  db.prepare(`UPDATE creation_exec_steps SET kind=?, title=?, details=?, payload=?, status='proposed', result=NULL WHERE id = ?`)
    .run(s.kind, s.title, s.details, s.payload ? JSON.stringify(s.payload) : null, id);
  return getStep(id);
}

async function firstMailAccount(): Promise<string> {
  const { listAccounts } = await import("../mail-accounts");
  const a = listAccounts().find((x) => x.status === "connected");
  if (!a) fail("no mail account is connected, so there's nowhere to put the draft");
  return a.email;
}

/** Owner only. Approve hands the step to Tasks / Communications / the approval queue; decline just records it. */
export async function decideStep(id: number, decision: unknown, actor = OWNER): Promise<Step> {
  if (decision !== "approve" && decision !== "decline" && decision !== "done") fail("decision must be approve, decline or done");
  if (isAgentActor(actor)) fail("only the owner can decide steps");
  const st = getStep(id);
  if (roleOf(st.creation_id, actor) !== "owner") fail("only the owner can decide steps");
  const title = (db.prepare(`SELECT title FROM creations WHERE id = ?`).get(st.creation_id) as { title: string }).title;

  if (decision === "done") {
    if (st.status !== "approved") fail("only an approved step can be marked done");
    db.prepare(`UPDATE creation_exec_steps SET status='done', done_at=datetime('now') WHERE id = ?`).run(id);
    db.prepare(`INSERT INTO creation_feed (creation_id, kind, title, actor, resolved_at) VALUES (?, 'step', ?, ?, datetime('now'))`).run(st.creation_id, `Done: ${st.title}`, actor);
    return getStep(id);
  }
  if (st.status !== "proposed" && st.status !== "failed") fail(`that step is already ${st.status}`);
  if (decision === "decline") {
    db.prepare(`UPDATE creation_exec_steps SET status='declined', decided_by=?, decided_at=datetime('now') WHERE id = ?`).run(actor, id);
    return getStep(id);
  }

  let result: string;
  try {
    const p = st.payload ?? {};
    const notes = `${st.details ? st.details + "\n\n" : ""}From The Creation: ${title}`;
    if (st.kind === "task") {
      const { createTask, ensureTasksSchema } = await import("../tasks");
      await ensureTasksSchema();
      const t = createTask({ title: st.title, notes, category: "The Creation", due_date: (p.due_date as string) || null, priority: (p.priority as string) || "normal" }, "creation");
      result = `Added to Tasks (#${t.id}).`;
    } else if (st.kind === "email") {
      const { createEmailDraft } = await import("../email-drafts");
      const d = createEmailDraft({
        account: (p.account as string) || (await firstMailAccount()),
        to: String(p.to), subject: String(p.subject), body: String(p.body),
        reason: `The Creation: ${title} — ${st.title}`, created_by: "creation",
      });
      result = `Draft #${d.draft_id} is in Communications → Email. ${d.note}`;
    } else if (st.kind === "meeting") {
      const { createApprovalRequest } = await import("../agents/registry");
      const r = createApprovalRequest({
        requested_by: "creation", action: "calendar_create", title: st.title,
        reason: `From The Creation: ${title}. ${st.details}`.slice(0, 1000),
        payload: { summary: st.title, start: p.start, end: p.end, attendees: p.attendees ?? [], description: notes },
      });
      result = `Calendar request #${r.request_id} is waiting in the approval queue (Team → Needs your approval). No invite goes out until you approve it there.`;
    } else {
      result = "Approved. Do it by hand, then mark it done.";
    }
  } catch (e) {
    db.prepare(`UPDATE creation_exec_steps SET status='failed', result=?, decided_by=?, decided_at=datetime('now') WHERE id = ?`).run((e as Error).message.slice(0, 1000), actor, id);
    return getStep(id);
  }
  db.prepare(`UPDATE creation_exec_steps SET status='approved', result=?, decided_by=?, decided_at=datetime('now') WHERE id = ?`).run(result, actor, id);
  db.prepare(`INSERT INTO creation_feed (creation_id, kind, title, body, actor, resolved_at) VALUES (?, 'step', ?, ?, ?, datetime('now'))`).run(st.creation_id, `Approved: ${st.title}`, result, actor);
  return getStep(id);
}
