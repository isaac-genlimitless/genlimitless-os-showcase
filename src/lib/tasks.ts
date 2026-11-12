import db from "./db";
import { findDuplicateTask } from "./dedupe";

// Owner's to-do list. There is deliberately NO delete function: completing a task sets
// status='done' (reversible by setting it back to 'open').

export const PRIORITIES = ["low", "normal", "high"] as const;
export const STATUSES = ["open", "done"] as const;

export type Task = {
  id: number;
  title: string;
  notes: string | null;
  category: string | null;
  status: "open" | "done";
  priority: "low" | "normal" | "high";
  due_date: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at?: string | null;
};

export type TaskInput = {
  title?: string;
  notes?: string | null;
  category?: string | null;
  status?: string;
  priority?: string;
  due_date?: string | null;
};

// Soft-remove support for the undo engine: an additive archived_at column (backup first, CLAUDE.md).
// No rows are ever removed. getTask still returns archived rows so a redo can restore them.
let archivedColumn = false;
const hasArchivedColumn = () => (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).some((c) => c.name === "archived_at");
let tasksSchemaReady: Promise<void> | null = null;

export function ensureTasksSchema(): Promise<void> {
  if (!tasksSchemaReady) {
    tasksSchemaReady = (async () => {
      if (!hasArchivedColumn()) {
        try {
          const { backupDatabase } = await import("./backup");
          await backupDatabase();
        } catch {
          /* backupDatabase logs its own failures */
        }
        if (!hasArchivedColumn()) db.exec(`ALTER TABLE tasks ADD COLUMN archived_at TEXT`);
      }
      archivedColumn = true;
    })().catch((err) => {
      tasksSchemaReady = null;
      throw err;
    });
  }
  return tasksSchemaReady;
}

if (hasArchivedColumn()) archivedColumn = true;
else ensureTasksSchema().catch(() => {});

const DATE_RE =/^\d{4}-\d{2}-\d{2}$/;

function realDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const t = new Date(d + "T00:00:00Z");
  return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

function check(i: TaskInput, creating: boolean): string | null {
  if (creating || i.title !== undefined) {
    if (typeof i.title !== "string" || !i.title.trim()) return "title is required";
  }
  if (i.priority !== undefined && !(PRIORITIES as readonly string[]).includes(i.priority)) return `priority must be one of: ${PRIORITIES.join(", ")}`;
  if (i.status !== undefined && !(STATUSES as readonly string[]).includes(i.status)) return `status must be one of: ${STATUSES.join(", ")}`;
  if (i.due_date !== undefined && i.due_date !== null && i.due_date !== "") {
    if (typeof i.due_date !== "string" || !realDate(i.due_date)) return "due_date must be a real date in YYYY-MM-DD format";
  }
  return null;
}

const textOrNull = (v: string | null | undefined): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
};

export function listTasks(f: { status?: "open" | "done" | "all"; category?: string } = {}): Task[] {
  const status = f.status ?? "open";
  const where: string[] = [];
  const args: string[] = [];
  if (archivedColumn) where.push("archived_at IS NULL");
  if (status !== "all") {
    where.push("status = ?");
    args.push(status);
  }
  if (f.category) {
    where.push("category = ?");
    args.push(f.category);
  }
  return db
    .prepare(
      `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY (status='done'), (due_date IS NULL), due_date,
                CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, id`
    )
    .all(...args) as Task[];
}

export function getTask(id: number): Task | null {
  return (db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Task | undefined) ?? null;
}

export function createTask(i: TaskInput, createdBy = "owner"): Task {
  const err = check(i, true);
  if (err) throw new Error(err);
  const done = i.status === "done";
  const r = db
    .prepare(
      `INSERT INTO tasks (title, notes, category, status, priority, due_date, created_by, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ${done ? "datetime('now')" : "NULL"})`
    )
    .run(i.title!.trim(), textOrNull(i.notes), textOrNull(i.category), done ? "done" : "open", i.priority ?? "normal", i.due_date || null, createdBy);
  return getTask(Number(r.lastInsertRowid))!;
}

/** Agent-facing create: returns a flat duplicate marker instead of inserting when an open task already matches. */
export function createTaskOrExisting(
  i: TaskInput,
  createdBy = "owner"
): Task | { duplicate: true; existing_task_number: number; message: string } {
  const err = check(i, true);
  if (err) throw new Error(err);
  const existing = findDuplicateTask({ title: i.title!, due_date: i.due_date, notes: i.notes }, listTasks({ status: "open" }));
  if (existing) {
    return {
      duplicate: true,
      existing_task_number: existing.id,
      message: `An open task already matches (id ${existing.id}). Nothing was created; use update_task to change it.`,
    };
  }
  return createTask(i, createdBy);
}

export function updateTask(id: number, patch: TaskInput): Task {
  const cur = getTask(id);
  if (!cur) throw new Error("task not found");
  const err = check(patch, false);
  if (err) throw new Error(err);
  const sets: string[] = [];
  const args: (string | null)[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    args.push(patch.title.trim());
  }
  if (patch.notes !== undefined) {
    sets.push("notes = ?");
    args.push(textOrNull(patch.notes));
  }
  if (patch.category !== undefined) {
    sets.push("category = ?");
    args.push(textOrNull(patch.category));
  }
  if (patch.priority !== undefined) {
    sets.push("priority = ?");
    args.push(patch.priority);
  }
  if (patch.due_date !== undefined) {
    sets.push("due_date = ?");
    args.push(patch.due_date || null);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
    if (patch.status === "done" && cur.status !== "done") sets.push("completed_at = datetime('now')");
    else if (patch.status === "open") sets.push("completed_at = NULL");
  }
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  return getTask(id)!;
}
