import db from "./db";

const RECOVERY_NOTE =
  "Server restarted while this was applying. Put back to pending approval so Owner can re-approve it. Some of its files may already be changed on disk; re-approving finishes or verifies it.";

// The fix build queue lives in memory, so at server boot any fix_proposals row still marked
// 'applying' is stale (its build died with the previous process). Put those rows back to
// pending_approval so they can be re-approved. Recovery only: never deletes, never marks
// anything applied, touches nothing but status/result of rows currently 'applying'.
export function recoverStuckFixes(database: { prepare: (sql: string) => any } = db): number {
  const rows = database.prepare("SELECT id FROM fix_proposals WHERE status='applying'").all() as { id: number }[];
  if (!rows.length) return 0;
  database
    .prepare(
      "UPDATE fix_proposals SET status='pending_approval', result=COALESCE(result||char(10)||char(10),'')||? WHERE status='applying'"
    )
    .run(RECOVERY_NOTE);
  return rows.length;
}
