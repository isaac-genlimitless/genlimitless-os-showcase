import db, { logIssue } from "./db";

// Logs an issue only if no OPEN issue with the same source + message already exists.
// Returns true if a new row was inserted, false if an identical open one was already there.
export function logIssueOnce(source: string, message: string, detail?: unknown): boolean {
  const existing = db
    .prepare("SELECT 1 FROM issues WHERE source=? AND message=? AND status='open' LIMIT 1")
    .get(source, message);
  if (existing) return false;
  logIssue(source, message, detail);
  return true;
}

/** Updates the detail of the open issue (source + message) or creates it. One issue per outage. */
export function upsertOpenIssue(source: string, message: string, detail?: unknown) {
  const existing = db
    .prepare("SELECT id FROM issues WHERE source=? AND message=? AND status='open' LIMIT 1")
    .get(source, message) as { id: number } | undefined;
  if (!existing) return logIssue(source, message, detail);
  db.prepare("UPDATE issues SET detail=? WHERE id=?").run(detail ? JSON.stringify(detail) : null, existing.id);
}

/** One open issue per source+message; repeats bump a counter and last_seen instead of adding rows. */
export function bumpOpenIssue(source: string, message: string, extra?: Record<string, unknown>): void {
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id, detail FROM issues WHERE source=? AND message=? AND status='open' LIMIT 1")
    .get(source, message) as { id: number; detail: string | null } | undefined;
  if (!existing) {
    logIssue(source, message, { count: 1, first_seen: now, last_seen: now, ...extra });
    return;
  }
  let prev: { count?: number; first_seen?: string } = {};
  try {
    prev = JSON.parse(existing.detail || "{}") as { count?: number; first_seen?: string };
  } catch {
    prev = {};
  }
  const next = { ...prev, count: (Number(prev.count) || 1) + 1, last_seen: now, ...extra };
  db.prepare("UPDATE issues SET detail=? WHERE id=?").run(JSON.stringify(next), existing.id);
}

/** Resolves every open issue from a source, optionally only those whose message starts with a prefix.
 *  Nothing is deleted; the note is appended to the detail. Returns how many were resolved. */
export function resolveIssuesBySource(source: string, note: string, messagePrefix?: string): number {
  const res = db
    .prepare(
      `UPDATE issues SET status='resolved', resolved_at=datetime('now'), detail=COALESCE(detail,'') || ?
       WHERE source=? AND status='open' AND (? IS NULL OR message LIKE ? || '%')`
    )
    .run(` | ${note}`, source, messagePrefix ?? null, messagePrefix ?? null);
  return res.changes;
}
