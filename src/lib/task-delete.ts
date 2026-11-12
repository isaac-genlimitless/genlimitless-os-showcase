import { getTask } from "./tasks";
import { removeTask } from "./task-remove";
import { createApprovalRequest } from "./agents/registry";

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Never touches the task: only files an approval request. */
export function requestTaskDelete(input: { task_ids: number[]; reason: string; requested_by: string }) {
  const found: { id: number; title: string }[] = [];
  const skipped: number[] = [];
  for (const id of input.task_ids) {
    const t: any = getTask(id);
    if (!t) throw new Error(`No task #${id}`);
    if (t.archived_at) { skipped.push(id); continue; }
    found.push({ id, title: String(t.title || "") });
  }
  if (!found.length) throw new Error(`Nothing to delete: ${skipped.map((i) => "#" + i).join(", ")} already deleted`);
  const ids = found.map((f) => f.id);
  const shown = found.slice(0, 10).map((f) => `#${f.id} "${cut(f.title, 50)}"`).join(", ");
  const more = found.length > 10 ? ` and ${found.length - 10} more` : "";
  const res = createApprovalRequest({
    requested_by: input.requested_by,
    action: "delete_task",
    target_id: ids.length === 1 ? ids[0] : undefined,
    title: `Delete ${ids.length} task${ids.length === 1 ? "" : "s"}: ${shown}${more}`,
    reason: input.reason,
    payload: { task_ids: ids },
  });
  return { ...(res as any), skipped_already_deleted: skipped };
}

/** Runs only from decideApproval on approve. Soft removal (archived_at); rows are kept. */
export async function applyTaskDelete(ids: number[]) {
  const removed: number[] = [];
  const not_found: number[] = [];
  for (const id of ids) {
    const t = await removeTask(id);
    if (t) removed.push(id); else not_found.push(id);
  }
  return { removed, not_found };
}
