import db from "./db";

// Handled-mail ledger: one row per (account, message_id) recording what the Chief of Staff
// decided, so sweeps never triage the same email twice. Additive only: rows are upserted, never deleted.
db.exec(`
CREATE TABLE IF NOT EXISTS mail_handled (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT,
  decision TEXT NOT NULL CHECK(decision IN ('drafted','task','tracker','noise')),
  draft_id INTEGER,
  note TEXT,
  handled_by TEXT,
  handled_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account, message_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_handled_thread ON mail_handled(account, thread_id);
`);

export type HandledDecision = "drafted" | "task" | "tracker" | "noise";

export type HandledEntry = {
  account: string;
  message_id: string;
  thread_id?: string | null;
  decision: HandledDecision;
  draft_id?: number | null;
  note?: string | null;
  handled_by?: string | null;
};

/** Upsert: on conflict updates the decision and timestamp. Never deletes. Returns rows written. */
export function markHandled(entries: HandledEntry[]): number {
  const stmt = db.prepare(
    `INSERT INTO mail_handled (account, message_id, thread_id, decision, draft_id, note, handled_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account, message_id) DO UPDATE SET
       thread_id = COALESCE(excluded.thread_id, mail_handled.thread_id),
       decision = excluded.decision,
       draft_id = excluded.draft_id,
       note = excluded.note,
       handled_by = excluded.handled_by,
       handled_at = datetime('now')`
  );
  let n = 0;
  db.transaction(() => {
    for (const e of entries) {
      stmt.run(e.account, e.message_id, e.thread_id ?? null, e.decision, e.draft_id ?? null, e.note ?? null, e.handled_by ?? null);
      n++;
    }
  })();
  return n;
}

export type LedgerMsg = { message_id?: string | null; id?: string | null; thread_id?: string | null; date?: string | number | Date | null };

function sqliteUtcMs(s: string): number {
  return new Date(s.replace(" ", "T") + "Z").getTime();
}

/** Splits messages into fresh (needs triage) and skipped (already handled). */
export function filterUnhandled<T extends LedgerMsg>(
  account: string,
  msgs: T[]
): { fresh: (T & { resurfaced?: boolean })[]; skipped: T[] } {
  const byMsg = new Set(
    (db.prepare(`SELECT message_id FROM mail_handled WHERE account = ?`).all(account) as { message_id: string }[]).map((r) => r.message_id)
  );
  const threadStmt = db.prepare(`SELECT MAX(handled_at) AS h FROM mail_handled WHERE account = ? AND thread_id = ?`);
  const fresh: (T & { resurfaced?: boolean })[] = [];
  const skipped: T[] = [];
  for (const m of msgs) {
    const keys = [m.message_id, m.id].filter((x): x is string => !!x);
    if (keys.some((k) => byMsg.has(k))) {
      skipped.push(m);
      continue;
    }
    if (m.thread_id) {
      const row = threadStmt.get(account, m.thread_id) as { h: string | null } | undefined;
      if (row?.h) {
        const handledMs = sqliteUtcMs(row.h);
        const dateMs = m.date ? new Date(m.date).getTime() : NaN;
        if (Number.isNaN(dateMs) || dateMs <= handledMs) {
          skipped.push(m);
          continue;
        }
        fresh.push({ ...m, resurfaced: true });
        continue;
      }
    }
    fresh.push(m);
  }
  return { fresh, skipped };
}

export function handledCounts(sinceISO?: string): { handled_total: number; by_decision: Record<string, number>; handled_today: number } {
  const since = sinceISO ? sinceISO.replace("T", " ").slice(0, 19) : null;
  const rows = (
    since
      ? db.prepare(`SELECT decision, COUNT(*) c FROM mail_handled WHERE handled_at >= ? GROUP BY decision`).all(since)
      : db.prepare(`SELECT decision, COUNT(*) c FROM mail_handled GROUP BY decision`).all()
  ) as { decision: string; c: number }[];
  const by_decision: Record<string, number> = {};
  let handled_total = 0;
  for (const r of rows) {
    by_decision[r.decision] = r.c;
    handled_total += r.c;
  }
  const today = db.prepare(`SELECT COUNT(*) c FROM mail_handled WHERE date(handled_at) = date('now')`).get() as { c: number };
  return { handled_total, by_decision, handled_today: today.c };
}

/** Records the ledger entries, then tries to label the mail. A label failure never undoes the ledger write. */
export async function markHandledAndLabel(
  entries: HandledEntry[],
  organize: (account: string, ids: string[], action: "add_label", label: string) => Promise<unknown>,
  label = "Chief-handled"
): Promise<{ recorded: number; label_applied: boolean }> {
  const recorded = markHandled(entries);
  let label_applied = true;
  const byAccount = new Map<string, string[]>();
  for (const e of entries) byAccount.set(e.account, [...(byAccount.get(e.account) || []), e.message_id]);
  for (const [account, ids] of byAccount) {
    try {
      await organize(account, ids, "add_label", label);
    } catch {
      label_applied = false;
    }
  }
  return { recorded, label_applied };
}
