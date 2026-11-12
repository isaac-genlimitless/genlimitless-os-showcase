// When a sent PR is OPEN and conflicts with main, queue ONE rebuild proposal for review.
// The old row's status column is never touched; only a note is appended to its result.

export type RebuildView = { state?: string | null; mergeable?: string | null; mergeStateStatus?: string | null };

type Stmt = { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => { lastInsertRowid: number | bigint } };
export type RebuildDb = { prepare: (sql: string) => Stmt };

export function needsRebuild(view: RebuildView): boolean {
  if (String(view.state || "").toUpperCase() !== "OPEN") return false;
  return String(view.mergeable || "").toUpperCase() === "CONFLICTING" || String(view.mergeStateStatus || "").toUpperCase() === "DIRTY";
}

type Row = {
  id: number;
  issue_id: number | null;
  title: string;
  diagnosis: string | null;
  proposed_change: string | null;
  files: string | null;
  kind: string | null;
  size: string | null;
  size_reasons: string | null;
  proposed_by: string | null;
  repo: string | null;
  result: string | null;
};

/** Returns the new row id, or null if one already exists (or the fix is missing). */
export function queueRebuild(db: RebuildDb, fixId: number, pr: number): number | null {
  const existing = db.prepare(`SELECT id FROM fix_proposals WHERE retry_of=?`).get(fixId);
  if (existing) return null;
  const row = db.prepare(`SELECT * FROM fix_proposals WHERE id=?`).get(fixId) as Row | undefined;
  if (!row) return null;
  const diagnosis = `${row.diagnosis ?? ""}\n\nApply after #${fixId} is closed. PR #${pr} conflicts with main; this rebuilds the same change on current main.`;
  const newId = Number(
    db
      .prepare(
        `INSERT INTO fix_proposals (issue_id, title, diagnosis, proposed_change, files, status, kind, size, size_reasons, proposed_by, repo, cos_review, retry_of)
         VALUES (?, ?, ?, ?, ?, 'pending_cos_review', ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(row.issue_id, `${row.title} (auto-rebuild of #${fixId} on current main)`, diagnosis, row.proposed_change, row.files, row.kind, row.size, row.size_reasons, row.proposed_by, row.repo, fixId)
      .lastInsertRowid
  );
  db.prepare(`UPDATE fix_proposals SET result=COALESCE(result,'')||? WHERE id=?`).run(`\n[rebuild queued as #${newId}]`, fixId);
  return newId;
}
