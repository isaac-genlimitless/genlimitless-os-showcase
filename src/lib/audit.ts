import db from "./db";

// Attribution for the status_audit triggers in db.ts. The triggers read the one-row audit_context
// table; anything that changes a status outside a withAudit/beginAudit scope is logged as 'system'.

/** Sets the audit actor/detail; returns a function that restores the previous values. */
export function beginAudit(actor: string, detail?: string): () => void {
  const prev = db.prepare(`SELECT actor, detail FROM audit_context WHERE id = 1`).get() as
    | { actor: string | null; detail: string | null }
    | undefined;
  db.prepare(`UPDATE audit_context SET actor = ?, detail = ? WHERE id = 1`).run(actor, detail ?? null);
  return () => {
    db.prepare(`UPDATE audit_context SET actor = ?, detail = ? WHERE id = 1`).run(prev?.actor ?? null, prev?.detail ?? null);
  };
}

/** Runs fn with the audit actor set, restoring the previous actor afterwards (sync or async fn). */
export function withAudit<T>(actor: string, detail: string | undefined, fn: () => T | Promise<T>): T | Promise<T> {
  const end = beginAudit(actor, detail);
  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (e) {
    end();
    throw e;
  }
  if (result && typeof (result as any).then === "function") {
    return (result as Promise<T>).finally(end);
  }
  end();
  return result;
}

/** A Central date ('2026-09-28') or full timestamp → the UTC 'YYYY-MM-DD HH:MM:SS' that created_at uses. */
function centralDayToUtc(v: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00-05:00`) : new Date(v);
  if (isNaN(d.getTime())) throw new Error(`Not a date: '${v}'. Use YYYY-MM-DD.`);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

