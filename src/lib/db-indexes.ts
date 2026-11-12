import db from "./db";
import { backupDatabase } from "./backup";

// Indexes for the queries that run every minute in the scheduler or on every page load.
// Without them SQLite reads the whole table each time, which gets slower as the business grows
// and holds up every other request while it runs (better-sqlite3 is synchronous).
//
// Several tables and columns are created lazily by the module that owns them, so each index is
// only created once its table and columns exist; ensureIndexes() is safe to call any number of times.
// Adding an index never changes or removes data.
export const INDEXES: { name: string; table: string; columns: string[] }[] = [
  { name: "idx_issues_status_source_msg", table: "issues", columns: ["status", "source", "message"] },
  { name: "idx_issues_status_created", table: "issues", columns: ["status", "created_at"] },
  { name: "idx_agent_runs_parent", table: "agent_runs", columns: ["parent_run_id", "status"] },
  { name: "idx_agent_runs_thread", table: "agent_runs", columns: ["thread", "status"] },
  { name: "idx_imessage_sends_status", table: "imessage_sends", columns: ["status", "created_at"] },
  { name: "idx_imessage_sends_purpose", table: "imessage_sends", columns: ["purpose", "created_at"] },
  { name: "idx_agent_activity_created", table: "agent_activity", columns: ["created_at"] },
  { name: "idx_agent_activity_agent", table: "agent_activity", columns: ["agent_slug", "created_at"] },
  { name: "idx_agent_learnings_agent", table: "agent_learnings", columns: ["agent_slug", "status"] },
  { name: "idx_approval_requests_status", table: "approval_requests", columns: ["status"] },
  { name: "idx_escalations_status", table: "escalations", columns: ["status"] },
  { name: "idx_fix_proposals_status", table: "fix_proposals", columns: ["status"] },
  { name: "idx_text_drafts_status", table: "text_drafts", columns: ["status"] },
  { name: "idx_email_drafts_status", table: "email_drafts", columns: ["status"] },
  { name: "idx_autopilot_sends_status", table: "autopilot_sends", columns: ["status", "send_at"] },
  { name: "idx_captures_status", table: "captures", columns: ["status"] },
  { name: "idx_schedule_items_date", table: "schedule_items", columns: ["date", "start"] },
  { name: "idx_schedule_items_status", table: "schedule_items", columns: ["status", "date"] },
  { name: "idx_meetings_page", table: "meetings", columns: ["page_id"] },
  { name: "idx_alerts_created", table: "alerts", columns: ["created_at"] },
  { name: "idx_alerts_reason", table: "alerts", columns: ["reason", "created_at"] },
  { name: "idx_mail_handled_at", table: "mail_handled", columns: ["handled_at"] },
  { name: "idx_inbound_emails_school", table: "inbound_emails", columns: ["school_id"] },
  { name: "idx_messages_status", table: "messages", columns: ["status"] },
  { name: "idx_messages_school", table: "messages", columns: ["school_id", "direction"] },
  { name: "idx_chat_history_thread", table: "chat_history", columns: ["thread_id", "id"] },
];

/** The indexes that are missing but can be created now (their table and columns exist). */
export function missingIndexes(): typeof INDEXES {
  const existing = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]).map((r) => r.name));
  return INDEXES.filter((ix) => {
    if (existing.has(ix.name)) return false;
    const cols = new Set((db.prepare(`SELECT name FROM pragma_table_info(?)`).all(ix.table) as { name: string }[]).map((r) => r.name));
    return ix.columns.every((c) => cols.has(c)); // skip until the owning module has created the table/column
  });
}

/** Creates the missing indexes. Returns the names it created. */
export function ensureIndexes(): string[] {
  const todo = missingIndexes();
  for (const ix of todo) db.exec(`CREATE INDEX IF NOT EXISTS ${ix.name} ON ${ix.table}(${ix.columns.join(", ")})`);
  return todo.map((ix) => ix.name);
}

/** Loads the modules that create the indexed tables, then indexes them. Called once at server start. */
export async function ensureIndexesAtStartup(): Promise<void> {
  const t = Date.now();
  await Promise.all([
    import("./agents/runs"), import("./agents/registry"), import("./email-drafts"), import("./autopilot"),
    import("./captures"), import("./meetings"), import("./mail-ledger"), import("./chat-threads"),
  ]);
  if (missingIndexes().length === 0) return;
  await backupDatabase(); // fresh snapshot before any schema change (CLAUDE.md data-safety rules)
  const created = ensureIndexes();
  if (created.length) console.log(`[db] created ${created.length} indexes in ${Date.now() - t}ms: ${created.join(", ")}`);
}
