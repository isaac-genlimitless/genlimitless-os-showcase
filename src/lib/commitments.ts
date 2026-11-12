import db, { snapshotBeforeNewTables } from "./db";
import { titleSimilarity } from "./dedupe";
import { createTaskOrExisting, getTask, updateTask } from "./tasks";
import { centralDateKey } from "./time";

// Commitments ledger: promises in both directions, pulled out of mail, texts, meetings and chat.
//  - owner_owes:     "I'll send you the deck Friday"  -> also a linked task on his to-do list
//  - owed_to_owner:  "I'll get back to you next week" -> Chief watches it and drafts a nudge when it goes quiet
// Never deleted: closing one sets status 'done' or 'cancelled' (the codebase's soft-delete convention).

snapshotBeforeNewTables("commitments", ["commitments"]);
db.exec(`
CREATE TABLE IF NOT EXISTS commitments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL CHECK (direction IN ('owner_owes','owed_to_owner')),
  person TEXT NOT NULL,              -- who it's owed to / owed by (name, ideally with email or handle)
  what TEXT NOT NULL,                -- the promise, as an action
  due_date TEXT,                     -- Central 'YYYY-MM-DD' or NULL
  source TEXT NOT NULL DEFAULT 'manual', -- email | text | meeting | chat | manual
  source_ref TEXT,                   -- message id / thread id / meeting id
  source_excerpt TEXT,               -- the words that made the promise
  status TEXT NOT NULL DEFAULT 'open', -- open | done | cancelled
  task_id INTEGER,                   -- linked task (owner_owes only)
  nudge_count INTEGER NOT NULL DEFAULT 0,
  last_nudged_at TEXT,
  close_note TEXT,
  created_by TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_commitments_open ON commitments(status, direction, due_date);
`);

export const DIRECTIONS = ["owner_owes", "owed_to_owner"] as const;
export const SOURCES = ["email", "text", "meeting", "chat", "manual"] as const;
export const COMMITMENT_STATUSES = ["open", "done", "cancelled"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export type Commitment = {
  id: number;
  direction: Direction;
  person: string;
  what: string;
  due_date: string | null;
  source: string;
  source_ref: string | null;
  source_excerpt: string | null;
  status: "open" | "done" | "cancelled";
  task_id: number | null;
  nudge_count: number;
  last_nudged_at: string | null;
  close_note: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const t = new Date(d + "T00:00:00Z");
  return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}
const clean = (s: unknown) => (typeof s === "string" && s.trim() ? s.trim() : null);

export function getCommitment(id: number): Commitment | undefined {
  return db.prepare(`SELECT * FROM commitments WHERE id=?`).get(id) as Commitment | undefined;
}

/** A linked task Owner ticked off closes the commitment with it (checked lazily on every read). */
function reconcileLinkedTasks() {
  const rows = db
    .prepare(`SELECT c.id FROM commitments c JOIN tasks t ON t.id = c.task_id WHERE c.status='open' AND c.direction='owner_owes' AND t.status='done'`)
    .all() as { id: number }[];
  const close = db.prepare(
    `UPDATE commitments SET status='done', close_note=COALESCE(close_note, 'Linked task marked done'), closed_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='open'`
  );
  for (const r of rows) close.run(r.id);
}

export function listCommitments(f: { status?: "open" | "done" | "cancelled" | "all"; direction?: Direction; person?: string; limit?: number } = {}): Commitment[] {
  reconcileLinkedTasks();
  const where: string[] = [];
  const args: unknown[] = [];
  const status = f.status ?? "open";
  if (status !== "all") {
    where.push("status = ?");
    args.push(status);
  }
  if (f.direction) {
    where.push("direction = ?");
    args.push(f.direction);
  }
  if (f.person?.trim()) {
    where.push("LOWER(person) LIKE ?");
    args.push(`%${f.person.trim().toLowerCase()}%`);
  }
  const sql = `SELECT * FROM commitments ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, due_date IS NULL, due_date ASC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, Math.min(Math.max(f.limit ?? 200, 1), 500)) as Commitment[];
}

export type CommitmentInput = {
  direction?: string;
  person?: string;
  what?: string;
  due_date?: string | null;
  source?: string;
  source_ref?: string | null;
  source_excerpt?: string | null;
};

function check(i: CommitmentInput): string | null {
  if (!i.direction || !(DIRECTIONS as readonly string[]).includes(i.direction)) return `direction must be one of: ${DIRECTIONS.join(", ")}`;
  if (!clean(i.person)) return "person is required (who it's owed to or by)";
  if (!clean(i.what)) return "what is required (the promise, as an action)";
  if (i.due_date && !validDate(i.due_date)) return "due_date must be a real date in YYYY-MM-DD format";
  if (i.source && !(SOURCES as readonly string[]).includes(i.source)) return `source must be one of: ${SOURCES.join(", ")}`;
  return null;
}

/** Same direction, same person, very similar promise, still open = the same commitment. */
export function findOpenDuplicate(i: { direction: string; person: string; what: string }): Commitment | null {
  const person = i.person.trim().toLowerCase();
  const open = db.prepare(`SELECT * FROM commitments WHERE status='open' AND direction=?`).all(i.direction) as Commitment[];
  return (
    open.find((c) => {
      const p = c.person.toLowerCase();
      const samePerson = p === person || p.includes(person) || person.includes(p);
      return samePerson && titleSimilarity(c.what, i.what) >= 0.6;
    }) || null
  );
}

/** Record a promise. Returns the existing open one (filling in a due date it lacked) instead of a duplicate. */
export function recordCommitment(i: CommitmentInput, createdBy = "owner"): Commitment & { duplicate?: boolean } {
  const err = check(i);
  if (err) throw new Error(err);
  const direction = i.direction as Direction;
  const person = clean(i.person)!;
  const what = clean(i.what)!;
  const dup = findOpenDuplicate({ direction, person, what });
  if (dup) {
    if (i.due_date && !dup.due_date) {
      db.prepare(`UPDATE commitments SET due_date=?, updated_at=datetime('now') WHERE id=?`).run(i.due_date, dup.id);
      if (dup.task_id && getTask(dup.task_id)?.status === "open") updateTask(dup.task_id, { due_date: i.due_date });
    }
    return { ...getCommitment(dup.id)!, duplicate: true };
  }
  const r = db
    .prepare(
      `INSERT INTO commitments (direction, person, what, due_date, source, source_ref, source_excerpt, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(direction, person, what, i.due_date || null, i.source || "manual", clean(i.source_ref), clean(i.source_excerpt)?.slice(0, 1000) ?? null, createdBy);
  const id = Number(r.lastInsertRowid);
  if (direction === "owner_owes") {
    // His promises land on his to-do list too, so they show up wherever he already looks.
    const t = createTaskOrExisting(
      {
        title: what,
        category: "Commitments",
        due_date: i.due_date || null,
        notes: `Promised to ${person}${i.source && i.source !== "manual" ? ` (${i.source})` : ""}. Commitment #${id}.${i.source_excerpt ? `\n"${clean(i.source_excerpt)!.slice(0, 300)}"` : ""}`,
      },
      createdBy
    );
    const taskId = "duplicate" in t ? t.existing_task_number : t.id;
    db.prepare(`UPDATE commitments SET task_id=? WHERE id=?`).run(taskId, id);
  }
  return getCommitment(id)!;
}

export function updateCommitment(
  id: number,
  patch: { what?: string; person?: string; due_date?: string | null; status?: string; close_note?: string | null }
): Commitment {
  const cur = getCommitment(id);
  if (!cur) throw new Error(`Commitment ${id} not found`);
  if (patch.status !== undefined && !(COMMITMENT_STATUSES as readonly string[]).includes(patch.status)) {
    throw new Error(`status must be one of: ${COMMITMENT_STATUSES.join(", ")}`);
  }
  if (patch.due_date && !validDate(patch.due_date)) throw new Error("due_date must be a real date in YYYY-MM-DD format");
  if (patch.what !== undefined && !clean(patch.what)) throw new Error("what can't be blank");
  if (patch.person !== undefined && !clean(patch.person)) throw new Error("person can't be blank");
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.what !== undefined) {
    sets.push("what=?");
    args.push(clean(patch.what));
  }
  if (patch.person !== undefined) {
    sets.push("person=?");
    args.push(clean(patch.person));
  }
  if (patch.due_date !== undefined) {
    sets.push("due_date=?");
    args.push(patch.due_date || null);
  }
  if (patch.close_note !== undefined) {
    sets.push("close_note=?");
    args.push(clean(patch.close_note));
  }
  if (patch.status !== undefined && patch.status !== cur.status) {
    sets.push("status=?");
    args.push(patch.status);
    sets.push(patch.status === "open" ? "closed_at=NULL" : "closed_at=datetime('now')");
  }
  if (!sets.length) return cur;
  sets.push("updated_at=datetime('now')");
  db.prepare(`UPDATE commitments SET ${sets.join(", ")} WHERE id=?`).run(...args, id);
  // Keep the linked task in step (done/reopen, due date). Cancelled leaves the task for Owner.
  if (cur.task_id && getTask(cur.task_id)) {
    const t: { status?: string; due_date?: string | null } = {};
    if (patch.status === "done") t.status = "done";
    if (patch.status === "open") t.status = "open";
    if (patch.due_date !== undefined) t.due_date = patch.due_date || null;
    if (Object.keys(t).length) updateTask(cur.task_id, t);
  }
  return getCommitment(id)!;
}

export function markNudged(id: number): Commitment {
  if (!getCommitment(id)) throw new Error(`Commitment ${id} not found`);
  db.prepare(`UPDATE commitments SET nudge_count=nudge_count+1, last_nudged_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(id);
  return getCommitment(id)!;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400e3);

/** Waiting-on items worth a nudge: past due, or (no due date) open 7+ days; never nudged in the last 3 days. */
export function staleWaitingOn(today = centralDateKey()): Commitment[] {
  return listCommitments({ direction: "owed_to_owner" }).filter((c) => {
    if (c.last_nudged_at && daysBetween(c.last_nudged_at.slice(0, 10), today) < 3) return false;
    if (c.due_date) return c.due_date < today;
    return daysBetween(c.created_at.slice(0, 10), today) >= 7;
  });
}

export function commitmentsOverview(today = centralDateKey()) {
  const open = listCommitments();
  const mine = open.filter((c) => c.direction === "owner_owes");
  const theirs = open.filter((c) => c.direction === "owed_to_owner");
  const soon = (c: Commitment) => !!c.due_date && c.due_date >= today && daysBetween(today, c.due_date) <= 2;
  return {
    overdue: mine.filter((c) => !!c.due_date && c.due_date < today),
    due_soon: mine.filter(soon),
    mine_open: mine.length,
    waiting_on: theirs,
    stale_waiting_on: staleWaitingOn(today),
  };
}

const line = (c: Commitment) => `- ${c.what} (${c.direction === "owner_owes" ? "to" : "from"} ${c.person}${c.due_date ? `, due ${c.due_date}` : ""}) [#${c.id}]`;

/** Built in code for the morning briefing, so it can't be forgotten or invented. "" when nothing's due. */
export function buildCommitmentsBriefingSection(today = centralDateKey()): string {
  const o = commitmentsOverview(today);
  const parts: string[] = [];
  if (o.overdue.length) parts.push(`Overdue promises:\n${o.overdue.slice(0, 8).map(line).join("\n")}`);
  if (o.due_soon.length) parts.push(`Due in the next 2 days:\n${o.due_soon.slice(0, 8).map(line).join("\n")}`);
  if (o.stale_waiting_on.length) parts.push(`Waiting on (gone quiet):\n${o.stale_waiting_on.slice(0, 8).map(line).join("\n")}`);
  return parts.length ? `**Commitments**\n${parts.join("\n")}` : "";
}
