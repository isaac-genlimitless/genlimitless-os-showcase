import db from "./db";
import { ensureTasksSchema, getTask, type Task } from "./tasks";

// Owner-requested task delete. Soft delete only: stamps tasks.archived_at (the same column the undo
// engine uses). The row is never removed and can be restored with archived_at = NULL.
export async function removeTask(id: number): Promise<Task | null> {
  await ensureTasksSchema();
  if (!getTask(id)) return null;
  db.prepare(`UPDATE tasks SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL`).run(id);
  return getTask(id);
}
