import db, { snapshotBeforeNewTables } from "./db";
import { getTask, updateTask, listTasks, type Task, type TaskInput } from "./tasks";
import { centralDateKey } from "./time";

// Task evidence log + safe auto-close policy. The policy lives in CODE: a model can never close a task
// on its own say-so. Evidence rows are never deleted. There is deliberately NO delete function here.
// 'Possibly done' = an open task with a pending possibly_done row (the tasks table is not altered).

snapshotBeforeNewTables("task_evidence", ["task_evidence"]);
db.exec(`
CREATE TABLE IF NOT EXISTS task_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('done','possibly_done')),
  source TEXT NOT NULL,              -- text_sent|text_received|email_sent|email_received|calendar|draft_sent|commitment|os
  source_ref TEXT NOT NULL,
  person TEXT,
  excerpt TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK(confidence IN ('high','medium','low')),
  reasoning TEXT,
  evidence_at TEXT,
  resolution TEXT NOT NULL DEFAULT 'pending', -- pending|auto_closed|confirmed|dismissed|reverted
  resolved_by TEXT,
  resolved_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(task_id, source, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_task_evidence_task ON task_evidence(task_id, resolution);
`);

export const EVIDENCE_SOURCES = ["text_sent", "text_received", "email_sent", "email_received", "calendar", "draft_sent", "commitment", "os"] as const;
const VERDICTS = ["done", "possibly_done"];
const CONFIDENCES = ["high", "medium", "low"];
const MAX_BULK = 50;

export type Evidence = {
  id: number;
  task_id: number;
  verdict: "done" | "possibly_done";
  source: string;
  source_ref: string;
  person: string | null;
  excerpt: string;
  confidence: "high" | "medium" | "low";
  reasoning: string | null;
  evidence_at: string | null;
  resolution: "pending" | "auto_closed" | "confirmed" | "dismissed" | "reverted";
  resolved_by: string | null;
  resolved_at: string | null;
  created_by: string;
  created_at: string;
};

export type EvidenceInput = {
  task_id: number;
  verdict: string;
  source: string;
  source_ref: string;
  person?: string | null;
  excerpt: string;
  confidence: string;
  reasoning?: string | null;
  evidence_at?: string | null;
};

export type RecordResult = { outcome: "auto_closed" | "flagged" | "ignored"; reason?: string; evidence_id?: number };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Parse ISO or SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) into ms; NaN if unparseable. */
function parseTime(s: string | null | undefined): number {
  if (!s || typeof s !== "string") return NaN;
  let v = s.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v)) v = v.replace(" ", "T") + "Z";
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) v += "Z";
  return Date.parse(v);
}

const isOpen = (t: Task | null): t is Task => !!t && t.status === "open" && !t.archived_at;

const getRow = (taskId: number, source: string, ref: string) =>
  db.prepare(`SELECT * FROM task_evidence WHERE task_id=? AND source=? AND source_ref=?`).get(taskId, source, ref) as Evidence | undefined;

export function recordEvidence(input: EvidenceInput, by: string, opts: { pack?: string } = {}): RecordResult {
  const taskId = Number(input?.task_id);
  const ref = typeof input?.source_ref === "string" ? input.source_ref.trim() : "";
  const excerpt = typeof input?.excerpt === "string" ? input.excerpt.trim() : "";
  if (!Number.isInteger(taskId)) return { outcome: "ignored", reason: "bad task_id" };
  if (!VERDICTS.includes(input.verdict)) return { outcome: "ignored", reason: "bad verdict" };
  if (!(EVIDENCE_SOURCES as readonly string[]).includes(input.source)) return { outcome: "ignored", reason: "bad source" };
  if (!CONFIDENCES.includes(input.confidence)) return { outcome: "ignored", reason: "bad confidence" };
  if (!ref) return { outcome: "ignored", reason: "source_ref is required" };
  if (excerpt.length < 8) return { outcome: "ignored", reason: "excerpt too short (min 8 chars)" };

  const task = getTask(taskId);
  if (!task) return { outcome: "ignored", reason: "task not found" };
  if (!isOpen(task)) return { outcome: "ignored", reason: "task is not open" };

  const existing = getRow(taskId, input.source, ref);
  if (existing && existing.resolution !== "pending") return { outcome: "ignored", reason: `evidence already ${existing.resolution}`, evidence_id: existing.id };

  // Auto-close policy: every condition must hold.
  const evMs = parseTime(input.evidence_at);
  const createdMs = parseTime(task.created_at);
  const packOk = typeof opts.pack === "string" && opts.pack.length > 0 && norm(opts.pack).includes(norm(excerpt));
  const canClose =
    input.verdict === "done" &&
    input.confidence === "high" &&
    !isNaN(evMs) &&
    !isNaN(createdMs) &&
    evMs > createdMs &&
    packOk;

  let id: number;
  if (existing) {
    id = existing.id;
  } else {
    const r = db
      .prepare(
        `INSERT INTO task_evidence (task_id, verdict, source, source_ref, person, excerpt, confidence, reasoning, evidence_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(taskId, input.verdict, input.source, ref, input.person?.trim() || null, excerpt, input.confidence, input.reasoning ?? null, input.evidence_at ?? null, by);
    id = Number(r.lastInsertRowid);
  }

  if (!canClose) return { outcome: "flagged", evidence_id: id, reason: existing ? "already pending" : undefined };

  const note = `Auto-closed ${centralDateKey()}: ${input.source} ${input.person?.trim() || ""} "${excerpt}" (ref ${ref})`.replace(/\s+"/, ' "');
  updateTask(taskId, { status: "done", notes: task.notes ? `${task.notes}\n${note}` : note });
  db.prepare(`UPDATE task_evidence SET resolution='auto_closed', resolved_by=?, resolved_at=datetime('now') WHERE id=?`).run(by, id);
  return { outcome: "auto_closed", evidence_id: id };
}

export function listEvidence(f: { task_id?: number; verdict?: string; resolution?: string; limit?: number } = {}): Evidence[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.task_id !== undefined) { where.push("task_id = ?"); args.push(f.task_id); }
  if (f.verdict) { where.push("verdict = ?"); args.push(f.verdict); }
  if (f.resolution) { where.push("resolution = ?"); args.push(f.resolution); }
  const limit = Math.max(1, Math.min(Number(f.limit) || 100, 1000));
  return db
    .prepare(`SELECT * FROM task_evidence ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit) as Evidence[];
}

export function listLikelyDone(): { task: Task; evidence: Evidence[] }[] {
  const out: { task: Task; evidence: Evidence[] }[] = [];
  for (const task of listTasks({ status: "open" })) {
    const evidence = db
      .prepare(`SELECT * FROM task_evidence WHERE task_id=? AND verdict='possibly_done' AND resolution='pending' ORDER BY id DESC`)
      .all(task.id) as Evidence[];
    if (evidence.length) out.push({ task, evidence });
  }
  return out;
}

export function listAutoClosed(days = 7): { task: Task; evidence: Evidence }[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT task_id FROM task_evidence WHERE resolution='auto_closed' AND resolved_at >= datetime('now', ?)`
    )
    .all(`-${Math.max(0, Number(days) || 0)} days`) as { task_id: number }[];
  const out: { task: Task; evidence: Evidence }[] = [];
  for (const { task_id } of rows) {
    const newest = db.prepare(`SELECT * FROM task_evidence WHERE task_id=? ORDER BY id DESC LIMIT 1`).get(task_id) as Evidence;
    const task = getTask(task_id);
    if (newest?.resolution === "auto_closed" && task && task.status === "done") out.push({ task, evidence: newest });
  }
  return out.sort((a, b) => b.evidence.id - a.evidence.id);
}

export function confirmLikelyDone(taskId: number, by: string): Task {
  const task = getTask(taskId);
  if (!task) throw new Error("task not found");
  const rows = db.prepare(`SELECT * FROM task_evidence WHERE task_id=? AND resolution='pending' ORDER BY id DESC`).all(taskId) as Evidence[];
  const note = `Confirmed done ${centralDateKey()} by ${by}: ${rows[0]?.excerpt ?? "no evidence excerpt"}`;
  const updated = updateTask(taskId, { status: "done", notes: task.notes ? `${task.notes}\n${note}` : note });
  db.prepare(`UPDATE task_evidence SET resolution='confirmed', resolved_by=?, resolved_at=datetime('now') WHERE task_id=? AND resolution='pending'`).run(by, taskId);
  return updated;
}

export function dismissLikelyDone(taskId: number, by: string): Task {
  const task = getTask(taskId);
  if (!task) throw new Error("task not found");
  db.prepare(`UPDATE task_evidence SET resolution='dismissed', resolved_by=?, resolved_at=datetime('now') WHERE task_id=? AND resolution='pending'`).run(by, taskId);
  return task;
}

export function revertAutoClose(taskId: number, by: string): Task {
  if (!getTask(taskId)) throw new Error("task not found");
  const updated = updateTask(taskId, { status: "open" });
  db.prepare(`UPDATE task_evidence SET resolution='reverted', resolved_by=?, resolved_at=datetime('now') WHERE task_id=? AND resolution='auto_closed'`).run(by, taskId);
  return updated;
}

export type BulkPatch = { status?: string; priority?: string; category?: string | null; due_date?: string | null; append_note?: string };
export type BulkResult = { id: number; ok: boolean; error?: string };

function cleanIds(ids: number[]): number[] {
  if (!Array.isArray(ids)) throw new Error("ids must be an array");
  const uniq = Array.from(new Set(ids.map(Number)));
  if (uniq.length > MAX_BULK) throw new Error(`too many ids (max ${MAX_BULK})`);
  return uniq;
}

export function bulkUpdateTasks(ids: number[], patch: BulkPatch, by: string): BulkResult[] {
  const list = cleanIds(ids);
  return list.map((id) => {
    try {
      const cur = getTask(id);
      if (!cur) return { id, ok: false, error: "task not found" };
      const p: TaskInput = {};
      if (patch.status !== undefined) p.status = patch.status;
      if (patch.priority !== undefined) p.priority = patch.priority;
      if (patch.category !== undefined) p.category = patch.category;
      if (patch.due_date !== undefined) p.due_date = patch.due_date;
      if (patch.append_note) {
        const line = `[${centralDateKey()} ${by}] ${patch.append_note}`;
        p.notes = cur.notes ? `${cur.notes}\n${line}` : line;
      }
      updateTask(id, p);
      return { id, ok: true };
    } catch (e) {
      return { id, ok: false, error: (e as Error).message };
    }
  });
}

export function flagPossiblyDone(ids: number[], opts: { reason: string; source?: string }, by: string): BulkResult[] {
  const list = cleanIds(ids);
  const ref = `manual-${by}-${centralDateKey()}`;
  const source = opts.source && (EVIDENCE_SOURCES as readonly string[]).includes(opts.source) ? opts.source : "os";
  return list.map((id) => {
    try {
      const task = getTask(id);
      if (!isOpen(task)) return { id, ok: false, error: "task not found or not open" };
      const reason = String(opts.reason ?? "").trim() || "flagged as possibly done";
      const excerpt = reason.length >= 8 ? reason : reason.padEnd(8, ".");
      db.prepare(
        `INSERT OR IGNORE INTO task_evidence (task_id, verdict, source, source_ref, excerpt, confidence, reasoning, created_by)
         VALUES (?, 'possibly_done', ?, ?, ?, 'medium', ?, ?)`
      ).run(id, source, ref, excerpt, reason, by);
      return { id, ok: true };
    } catch (e) {
      return { id, ok: false, error: (e as Error).message };
    }
  });
}

export function resolveEvidence(evidenceIds: number[], action: "confirm" | "dismiss" | "revert", by: string): BulkResult[] {
  if (!["confirm", "dismiss", "revert"].includes(action)) throw new Error("action must be confirm, dismiss or revert");
  const list = cleanIds(evidenceIds);
  return list.map((id) => {
    try {
      const row = db.prepare(`SELECT * FROM task_evidence WHERE id=?`).get(id) as Evidence | undefined;
      if (!row) return { id, ok: false, error: "evidence not found" };
      if (action === "confirm") {
        if (row.resolution !== "pending") return { id, ok: false, error: `evidence is ${row.resolution}` };
        confirmLikelyDone(row.task_id, by);
      } else if (action === "dismiss") {
        if (row.resolution !== "pending") return { id, ok: false, error: `evidence is ${row.resolution}` };
        dismissLikelyDone(row.task_id, by);
      } else {
        if (row.resolution !== "auto_closed") return { id, ok: false, error: `evidence is ${row.resolution}` };
        revertAutoClose(row.task_id, by);
      }
      return { id, ok: true };
    } catch (e) {
      return { id, ok: false, error: (e as Error).message };
    }
  });
}
