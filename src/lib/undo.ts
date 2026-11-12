import { ownerName } from "./instance";
import db from "./db";
import { withAudit } from "./audit";
import { ensureUndoSchema } from "./undo-log";
import { ensureTasksSchema, updateTask } from "./tasks";
import { archivePage, restorePage, updatePage, movePage } from "./pages";
import { editEmailDraft } from "./email-drafts";
import { editTextDraft } from "./text-drafts";
import { applyScheduledTextCancel } from "./scheduled-texts";
import { retireAgent, restoreAgent, updateAgent, setLearningStatus, setPriority } from "./agents/registry";
import { externalCannot, externalConflict, reverseExternal, reapplyExternal, withTimeout } from "./undo-external";
import "./chat-threads"; // makes sure chat_history.thread_id exists

// Undo log, part 2: REVERSES what an AI chat turn changed (recorded by undo-log.ts, part 1).
// Nothing is ever hard-deleted: every reversal uses the item's own soft path (archive / cancelled /
// dropped / retired / previous values). Only reachable from Owner's click via /api/chat/undo; this is
// NOT an agent tool. Approved/scheduled sends are never touched, so the approval flow stays the only
// path for them. External items (calendar, mail, Notion) come in part 4.

type Json = Record<string, any>;
type Row = {
  id: number;
  run_id: number;
  root_run_id: number;
  entity: string;
  entity_id: string | null;
  op: string;
  label: string;
  before_json: string | null;
  after_json: string | null;
  undoable: number;
  not_undoable_reason: string | null;
  state: string;
  error: string | null;
};

export type Conflict = { label: string; changed_by: string };
export type Preview = {
  status: "none" | "available" | "undone" | "running";
  reversible: { action_id: number; label: string; conflict?: Conflict }[];
  cannot: { label: string; reason: string }[];
};
export type UndoSummary = { done: string[]; skipped: string[]; failed: string[]; note: string };

const TABLES: Record<string, { table: string; key: string }> = {
  page: { table: "docs", key: "id" },
  task: { table: "tasks", key: "id" },
  email_draft: { table: "email_drafts", key: "id" },
  text_draft: { table: "text_drafts", key: "id" },
  priority: { table: "owner_priorities", key: "id" },
  learning: { table: "agent_learnings", key: "id" },
  agent: { table: "agents", key: "slug" },
  scheduled_text: { table: "scheduled_texts", key: "id" },
};
const EXTERNAL = new Set(["calendar_event", "mail", "notion_page"]);
const SENT = new Set(["sent", "delivered"]);
const pj = (s: string | null): Json | null => {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

function currentRow(entity: string, id: string | null): Json | null {
  const t = TABLES[entity];
  if (!t || id == null) return null;
  return (db.prepare(`SELECT * FROM ${t.table} WHERE ${t.key}=?`).get(id) as Json | undefined) ?? null;
}

const norm = (v: unknown) => (v === undefined || v === null ? null : typeof v === "object" ? JSON.stringify(v) : String(v));

function runTree(rootRunId: number): number[] {
  return (db
    .prepare(
      `WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT r.id FROM agent_runs r JOIN t ON r.parent_run_id = t.id) SELECT id FROM t`
    )
    .all(rootRunId) as { id: number }[]).map((r) => r.id);
}

function turnRun(chatId: number): number | null {
  const r = db.prepare(`SELECT run_id FROM chat_turn_runs WHERE chat_id=?`).get(chatId) as { run_id: number } | undefined;
  return r ? r.run_id : null;
}

function turnRows(runId: number): Row[] {
  return db.prepare(`SELECT * FROM undo_actions WHERE root_run_id=? ORDER BY id`).all(runId) as Row[];
}

function isRunning(runId: number): boolean {
  const ids = runTree(runId);
  const n = db.prepare(`SELECT COUNT(*) c FROM agent_runs WHERE status='running' AND id IN (${ids.map(Number).join(",")})`).get() as { c: number };
  return n.c > 0;
}

/** Why this row can no longer be reversed from chat, or null when it can. `forRedo` checks the redo direction. */
function cannotReason(r: Row, forRedo = false): string | null {
  if (!r.undoable) {
    const reason = r.not_undoable_reason || "Can't be undone from chat";
    const m = /^Approval request(?: #(\d+))?/.exec(reason);
    if (m && m[1]) {
      const a = db.prepare(`SELECT status FROM approval_requests WHERE id=?`).get(Number(m[1])) as { status: string } | undefined;
      if (a && a.status !== "pending") return `Approval request #${m[1]} already decided`;
    }
    return reason;
  }
  if (EXTERNAL.has(r.entity)) return externalCannot(r);
  const cur = currentRow(r.entity, r.entity_id);
  if (!cur) return "Item no longer exists";
  const st = String(cur.status ?? "");
  if (["email_draft", "text_draft", "scheduled_text"].includes(r.entity)) {
    if (SENT.has(st)) return "Already sent";
    if (!forRedo) {
      const open = r.entity === "scheduled_text" ? "pending" : "pending_approval";
      if (st !== open) return st === "cancelled" ? "Already cancelled" : `Already ${st}`;
    }
  }
  return null;
}

function conflictFor(r: Row, all: Row[], forRedo: boolean): Conflict | undefined {
  // A later reply touched the same item and is still on record.
  const later = db
    .prepare(`SELECT label FROM undo_actions WHERE id>? AND root_run_id!=? AND state='recorded' AND entity=? AND entity_id IS ? ORDER BY id LIMIT 1`)
    .get(r.id, r.root_run_id, r.entity, r.entity_id) as { label: string } | undefined;
  if (later) return { label: later.label, changed_by: "a later reply" };
  // Same-turn chains are checked only on the newest row of the chain.
  const newerSame = all.some((o) => o.id > r.id && o.entity === r.entity && o.entity_id === r.entity_id && o.undoable);
  if (newerSame) return undefined;
  const expect = forRedo ? (r.op === "create" ? null : pj(r.before_json)) : pj(r.after_json);
  if (!expect) return undefined;
  const cur = currentRow(r.entity, r.entity_id);
  if (!cur) return undefined;
  for (const k of Object.keys(expect)) {
    if (!(k in cur)) continue;
    if (norm(cur[k]) !== norm(expect[k])) return { label: `"${k}" was changed after the reply`, changed_by: `${ownerName()} or another change` };
  }
  return undefined;
}

export function previewTurn(chatId: number): Preview {
  const runId = turnRun(chatId);
  if (runId == null) return { status: "none", reversible: [], cannot: [] };
  if (isRunning(runId)) return { status: "running", reversible: [], cannot: [] };
  const rows = turnRows(runId);
  const out: Preview = { status: "none", reversible: [], cannot: [] };
  let hasUndone = false;
  let hasRecorded = false;
  for (const r of rows) {
    if (r.state === "undone") {
      hasUndone = true;
      continue;
    }
    const why = cannotReason(r);
    if (why) {
      if (r.state === "recorded" || r.state === "skipped" || r.state === "failed") out.cannot.push({ label: r.label, reason: why });
      continue;
    }
    if (r.state === "recorded") hasRecorded = true;
    const conflict = conflictFor(r, rows, false);
    out.reversible.push({ action_id: r.id, label: r.label, ...(conflict ? { conflict } : {}) });
  }
  out.status = hasRecorded ? "available" : hasUndone || out.reversible.length ? "undone" : "none";
  if (!hasRecorded && !hasUndone && out.reversible.length) out.status = "available";
  return out;
}

/** previewTurn plus a live check of calendar / mail / Notion items. Never throws. */
export async function previewTurnLive(chatId: number): Promise<Preview> {
  const p = previewTurn(chatId);
  try {
    const ids = p.reversible.filter((x) => !x.conflict).map((x) => Number(x.action_id)).filter((n) => Number.isInteger(n));
    if (!ids.length) return p;
    const rows = db.prepare(`SELECT * FROM undo_actions WHERE id IN (${ids.join(",")})`).all() as Row[];
    await Promise.all(
      rows
        .filter((r) => EXTERNAL.has(r.entity))
        .map(async (r) => {
          const c = await withTimeout(externalConflict(r, false), 8000);
          if (c) {
            const item = p.reversible.find((x) => x.action_id === r.id);
            if (item) item.conflict = c;
          }
        })
    );
  } catch {
    /* fall back to the plain preview */
  }
  return p;
}

// ---------------------------------------------------------------- applying one row

const PAGE_EDIT = ["title", "icon", "tags", "summary", "category", "favorite", "link"];

async function applySnapshot(r: Row, snap: Json): Promise<void> {
  const id = r.entity_id!;
  const has = (k: string) => k in snap;
  switch (r.entity) {
    case "page": {
      if (r.op === "move") {
        movePage(Number(id), snap.parent_id ?? null, snap.placed_by === "ai" ? "ai" : "owner");
        if (typeof snap.sort_order === "number") db.prepare(`UPDATE docs SET sort_order=? WHERE id=?`).run(snap.sort_order, Number(id));
        return;
      }
      const ch: Json = {};
      for (const k of PAGE_EDIT) if (has(k)) ch[k] = snap[k];
      if (has("tags")) ch.tags = typeof snap.tags === "string" ? (pj(snap.tags) ?? JSON.parse(snap.tags || "[]")) : snap.tags || [];
      if (has("favorite")) ch.favorite = !!snap.favorite;
      if (has("title") && ch.title == null) delete ch.title;
      if (has("content") && snap.content) {
        try {
          const blocks = JSON.parse(snap.content);
          if (Array.isArray(blocks)) ch.content = blocks;
        } catch {
          /* fall back to body */
        }
      }
      if (ch.content === undefined && has("body") && snap.body != null) ch.body = snap.body;
      await updatePage(Number(id), ch, { source: "undo" });
      return;
    }
    case "task": {
      const ch: Json = {};
      for (const k of ["title", "notes", "category", "priority", "due_date", "status"]) if (has(k)) ch[k] = snap[k];
      updateTask(Number(id), ch);
      return;
    }
    case "email_draft": {
      const ch: Json = {};
      if (has("to_addr")) ch.to = snap.to_addr;
      for (const k of ["subject", "body", "account"]) if (has(k)) ch[k] = snap[k];
      editEmailDraft(Number(id), ch);
      return;
    }
    case "text_draft": {
      const ch: Json = {};
      for (const k of ["text", "suggested_send_at"]) if (has(k) && snap[k] != null) ch[k] = snap[k];
      editTextDraft(Number(id), ch);
      return;
    }
    case "priority": {
      const ch: Json = { id: Number(id) };
      for (const k of ["title", "detail", "rank", "status"]) if (has(k) && snap[k] != null) ch[k] = snap[k];
      setPriority(ch);
      return;
    }
    case "learning": {
      if (has("status")) setLearningStatus(Number(id), snap.status === "retired" ? "retired" : "active", "owner", "undo");
      return;
    }
    case "agent": {
      const ch: Json = {};
      for (const k of ["name", "objective", "responsibilities", "instructions", "tools", "default_model", "default_effort"]) if (has(k)) ch[k] = snap[k];
      if (Object.keys(ch).length) updateAgent(id, ch, "owner", "Undo of AI reply");
      if (has("status")) {
        if (snap.status === "retired") retireAgent(id, "owner", "Undo of AI reply");
        else restoreAgent(id, "owner", "Undo of AI reply");
      }
      return;
    }
  }
  throw new Error(`Can't reverse ${r.entity} yet`);
}

/** Undoes one row. */
async function reverse(r: Row): Promise<void> {
  if (EXTERNAL.has(r.entity)) return reverseExternal(r);
  const id = r.entity_id!;
  if (r.op === "create") {
    switch (r.entity) {
      case "page":
        archivePage(Number(id));
        return;
      case "task":
        db.prepare(`UPDATE tasks SET archived_at=datetime('now') WHERE id=?`).run(Number(id));
        return;
      case "email_draft":
        db.prepare(`UPDATE email_drafts SET status='cancelled', updated_at=datetime('now') WHERE id=? AND status='pending_approval'`).run(Number(id));
        return;
      case "text_draft":
        db.prepare(`UPDATE text_drafts SET status='cancelled' WHERE id=? AND status='pending_approval'`).run(Number(id));
        return;
      case "priority":
        setPriority({ id: Number(id), status: "dropped" });
        return;
      case "learning":
        setLearningStatus(Number(id), "retired", "owner", "undo");
        return;
      case "agent":
        retireAgent(id, "owner", "Undo of AI reply");
        return;
      case "scheduled_text":
        applyScheduledTextCancel(Number(id), "Undone by Owner");
        return;
    }
    throw new Error(`Can't reverse ${r.entity} yet`);
  }
  const before = pj(r.before_json);
  if (!before) throw new Error("No before-state was recorded");
  await applySnapshot(r, before);
}

/** Redoes one undone row. */
async function reapply(r: Row): Promise<void> {
  if (EXTERNAL.has(r.entity)) return reapplyExternal(r);
  const id = r.entity_id!;
  const after = pj(r.after_json);
  if (r.op === "create") {
    const prior = after?.status;
    switch (r.entity) {
      case "page":
        restorePage(Number(id));
        return;
      case "task":
        db.prepare(`UPDATE tasks SET archived_at=NULL WHERE id=?`).run(Number(id));
        return;
      case "email_draft":
        db.prepare(`UPDATE email_drafts SET status=?, updated_at=datetime('now') WHERE id=? AND status='cancelled'`).run(prior || "pending_approval", Number(id));
        return;
      case "text_draft":
        db.prepare(`UPDATE text_drafts SET status=? WHERE id=? AND status='cancelled'`).run(prior || "pending_approval", Number(id));
        return;
      case "priority":
        db.prepare(`UPDATE owner_priorities SET status=?, updated_at=datetime('now') WHERE id=? AND status='dropped'`).run(prior || "active", Number(id));
        return;
      case "learning":
        setLearningStatus(Number(id), "active", "owner", "redo");
        return;
      case "agent":
        restoreAgent(id, "owner", "Redo of AI reply");
        return;
      case "scheduled_text":
        db.prepare(`UPDATE scheduled_texts SET status=?, cancelled_at=NULL, cancel_reason=NULL WHERE id=? AND status='cancelled'`).run(prior || "pending", Number(id));
        return;
    }
    throw new Error(`Can't redo ${r.entity} yet`);
  }
  if (!after) throw new Error("No after-state was recorded");
  await applySnapshot(r, after);
}

// ---------------------------------------------------------------- undo / redo

function postNote(chatId: number, text: string) {
  const reply = db.prepare(`SELECT thread_id FROM chat_history WHERE id=?`).get(chatId) as { thread_id: number | null } | undefined;
  db.prepare(`INSERT INTO chat_history (role, content, thread_id) VALUES ('assistant', ?, ?)`).run(text, reply?.thread_id ?? null);
}

function summarize(verb: "Undid" | "Redid", arrow: string, done: string[], skipped: string[], failed: string[]): string {
  let s = `${arrow} ${verb} ${done.length} change(s) from this reply${done.length ? ": " + done.join("; ") : ""}.`;
  if (skipped.length) s += ` Skipped: ${skipped.join("; ")}.`;
  if (failed.length) s += ` Couldn't ${verb === "Undid" ? "undo" : "redo"}: ${failed.join("; ")}.`;
  return s;
}

async function run(chatId: number, redo: boolean, overwrite: number[]): Promise<UndoSummary> {
  await ensureUndoSchema();
  await ensureTasksSchema();
  const runId = turnRun(chatId);
  if (runId == null) throw new UndoError("Nothing to " + (redo ? "redo" : "undo") + " for this reply", 404);
  if (isRunning(runId)) throw new UndoError("Still working, try again when it finishes", 409);
  const rows = turnRows(runId);
  const want = redo
    ? rows.filter((r) => r.state === "undone")
    : rows.filter((r) => r.undoable && (r.state === "recorded" || r.state === "skipped" || r.state === "failed"));
  if (!want.length) throw new UndoError(redo ? "Nothing to redo" : "Nothing left to undo", 409);
  if (!redo && !want.some((r) => r.state === "recorded") && !want.some((r) => !cannotReason(r))) throw new UndoError("Nothing left to undo", 409);
  const ordered = redo ? want : [...want].reverse(); // undo: newest first; redo: oldest first
  const done: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const allow = new Set(overwrite);

  await withAudit("owner:undo", `chat ${chatId}`, async () => {
    for (const r of ordered) {
      const why = cannotReason(r, redo);
      if (why) {
        if (!redo) continue; // listed in the preview under "can't undo"; left untouched
        failed.push(`${r.label} (${why})`);
        continue;
      }
      const conflict = conflictFor(r, rows, redo) ?? (EXTERNAL.has(r.entity) ? await externalConflict(r, redo) : undefined);
      if (conflict && !allow.has(r.id)) {
        skipped.push(`${r.label} (${conflict.label})`);
        if (!redo) db.prepare(`UPDATE undo_actions SET state='skipped' WHERE id=?`).run(r.id);
        continue;
      }
      try {
        if (redo) await reapply(r);
        else await reverse(r);
        db.prepare(`UPDATE undo_actions SET state=?, undone_at=?, error=NULL WHERE id=?`).run(
          redo ? "recorded" : "undone",
          redo ? null : new Date().toISOString().slice(0, 19).replace("T", " "),
          r.id
        );
        done.push(r.label);
      } catch (e) {
        const msg = (e as Error)?.message || String(e);
        db.prepare(`UPDATE undo_actions SET state='failed', error=? WHERE id=?`).run(msg.slice(0, 500), r.id);
        failed.push(`${r.label} (${msg})`);
      }
    }
    const note = summarize(redo ? "Redid" : "Undid", redo ? "↪︎" : "↩︎", done, skipped, failed);
    postNote(chatId, note);
  });
  return { done, skipped, failed, note: summarize(redo ? "Redid" : "Undid", redo ? "↪︎" : "↩︎", done, skipped, failed) };
}

export class UndoError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export function undoTurn(chatId: number, opts: { overwrite?: number[] } = {}): Promise<UndoSummary> {
  return run(chatId, false, opts.overwrite ?? []);
}

export function redoTurn(chatId: number, opts: { overwrite?: number[] } = {}): Promise<UndoSummary> {
  return run(chatId, true, opts.overwrite ?? []);
}
