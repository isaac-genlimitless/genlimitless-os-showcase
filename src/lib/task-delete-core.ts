// Pure helpers for the delete_task approval flow (no database access).
export const MAX_DELETE_TASKS = 30;

export function normalizeTaskIds(input: { task_id?: unknown; task_ids?: unknown }): number[] {
  const raw: unknown[] = [];
  if (input.task_id !== undefined && input.task_id !== null) raw.push(input.task_id);
  if (input.task_ids !== undefined && input.task_ids !== null) {
    if (!Array.isArray(input.task_ids)) throw new Error("task_ids must be an array of task numbers");
    raw.push(...input.task_ids);
  }
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new Error(`Invalid task id: ${JSON.stringify(v)} (must be a positive whole number)`);
  }
  const ids = [...new Set(raw as number[])];
  if (ids.length < 1) throw new Error("Give task_id or task_ids (at least 1 task)");
  if (ids.length > MAX_DELETE_TASKS) throw new Error(`Too many tasks (${ids.length}); the limit is ${MAX_DELETE_TASKS} per request`);
  return ids;
}
