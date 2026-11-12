import type Database from "better-sqlite3";
import fs from "fs";

// Additive, idempotent accounts.db migration. Never removes, renames or rewrites anything.
const ADDS: [string, string, string][] = [
  ["users", "removed_at", "INTEGER"],
  ["users", "updated_at", "INTEGER"],
  ["auth_sessions", "impersonator_id", "TEXT"],
  ["auth_sessions", "read_only", "INTEGER DEFAULT 0"],
];

function columns(d: Database.Database, table: string): Set<string> {
  const rows = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

export function migrateAccounts(d: Database.Database, dbFile: string): void {
  const missing = ADDS.filter(([t, c]) => !columns(d, t).has(c));
  if (missing.length) {
    const n = (d.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n;
    if (n > 0) {
      try {
        d.pragma("wal_checkpoint(TRUNCATE)");
        fs.copyFileSync(dbFile, `${dbFile}.pre-users-${Date.now()}`); // a copy; nothing is overwritten
      } catch {
        /* a failed backup copy must not stop startup; the ALTERs below are additive */
      }
    }
    for (const [t, c, type] of missing) {
      try {
        d.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`);
      } catch (e) {
        if (!/duplicate column/i.test(String(e))) throw e; // another process won the race
      }
    }
  }
  d.exec(`CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    ip TEXT
  )`);
}
