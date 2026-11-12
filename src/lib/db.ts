import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

import { DATA_DIR as dataDir } from "./data-dir";
import { isOwnerCell } from "./instance";
// Playwright sets TEST_WORKER_INDEX in every worker. Test processes may only open a throwaway DB.
const underTest = process.env.TEST_WORKER_INDEX !== undefined || !!process.env.E2E_START_SERVER;
if (underTest) {
  const real = path.resolve(dataDir);
  if (!path.basename(real).startsWith("genlimitless-e2e-data-") || real === path.resolve(process.cwd(), "data")) {
    throw new Error(`Refusing to open ${real}/genlimitless.db from a test process: tests may only use a genlimitless-e2e-data-* temp dir.`);
  }
}
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "genlimitless.db"));
db.pragma("journal_mode = WAL");

// Additive migrations all follow "check PRAGMA table_info, then ALTER TABLE ADD COLUMN". Two processes starting on a
// fresh database at once (e.g. `next build` page-data workers) can both see the column missing; the loser's ALTER then
// fails with "duplicate column name". The column exists either way, so treat that one error as success. Single
// statements only, so a multi-statement script can never have its remainder skipped.
const rawExec = db.exec.bind(db);
db.exec = (sql: string) => {
  try {
    return rawExec(sql);
  } catch (err) {
    const single = !/;\s*\S/.test(sql);
    if (single && /^\s*ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\b/i.test(sql) && /duplicate column name/i.test(String((err as Error).message))) {
      return db;
    }
    throw err;
  }
};

db.exec(`
CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  website TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  linkedin_url TEXT,
  facebook_url TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  channel TEXT NOT NULL DEFAULT 'email',
  direction TEXT NOT NULL DEFAULT 'outbound',
  step TEXT NOT NULL DEFAULT 'initial',
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  scheduled_for TEXT,
  sent_at TEXT,
  from_address TEXT,
  message_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS imessage_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_handle TEXT,
  chat_guid TEXT,
  text TEXT NOT NULL,
  purpose TEXT NOT NULL,            -- 'alert' | 'manual'
  status TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | failed | fallback_email
  attempts INTEGER NOT NULL DEFAULT 0,
  chat_rowid INTEGER,
  error TEXT,
  last_attempt_at INTEGER,          -- unix ms
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Login 2FA codes sent by iMessage. Only an HMAC hash is stored, never the code.
CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,      -- unix ms
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,                  -- unix ms; also set when burned/invalidated
  created_at INTEGER NOT NULL       -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_login_codes_challenge ON login_codes(challenge_id);

CREATE TABLE IF NOT EXISTS fix_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER REFERENCES issues(id),
  title TEXT NOT NULL,
  diagnosis TEXT NOT NULL,
  proposed_change TEXT NOT NULL,
  files TEXT,
  status TEXT NOT NULL DEFAULT 'pending_approval', -- pending_approval | applying | applied | failed | dismissed
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cleanup_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'pending', -- pending | applied | superseded
  items_json TEXT,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS message_changelog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS mail_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  label TEXT,
  kind TEXT NOT NULL DEFAULT 'gmail_oauth',
  refresh_token TEXT,
  scopes TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  connected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  created_by TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS text_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_handle TEXT,
  chat_guid TEXT,
  contact_name TEXT,
  text TEXT NOT NULL,
  reason TEXT,
  suggested_send_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending_approval', -- pending_approval | sent | cancelled
  approved_by TEXT,                                -- 'owner' | 'agent_auto'
  send_id INTEGER REFERENCES imessage_sends(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS text_autosend_allowlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Real-time inbound email queue: one row per message the IMAP IDLE watcher (or the
-- offline simulate-inbound fixture) hands to onInboundEmail. UNIQUE(account, message_id)
-- is the idempotency guarantee - a re-delivered message is a no-op.
CREATE TABLE IF NOT EXISTS inbound_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,
  message_id TEXT NOT NULL,
  uid INTEGER,
  from_address TEXT NOT NULL,
  to_address TEXT,
  subject TEXT,
  body TEXT NOT NULL DEFAULT '',
  school_id INTEGER REFERENCES schools(id),
  classification TEXT NOT NULL DEFAULT 'other',
  skip_reason TEXT,
  notify_needed INTEGER NOT NULL DEFAULT 0,
  agent_status TEXT NOT NULL DEFAULT 'pending', -- pending | processing | done | skipped
  agent_summary TEXT,
  reminded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account, message_id)
);

-- Per-account IMAP IDLE watch health, so a watchdog can tell "quiet inbox" from "watch is down".
CREATE TABLE IF NOT EXISTS imap_watch_state (
  account TEXT PRIMARY KEY,
  last_uid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle', -- idle | watching | error
  last_seen_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Idempotency for jobs that must run once per key (a Central calendar date for the daily
-- schedule, an "account:event id" for meeting prep) even across a server restart that lands
-- after the job's normal trigger time. See src/lib/schedule.ts.
CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  run_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done', -- done | failed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job, run_key)
);

-- The Chief of Staff's proposed time blocks for a day (new focus blocks / holds only — existing
-- meetings stay on the calendar untouched and are shown live, not stored here). Nothing here
-- writes to any calendar until Owner approves the specific row: see src/lib/schedule.ts.
CREATE TABLE IF NOT EXISTS schedule_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,              -- Central calendar date, 'YYYY-MM-DD'
  title TEXT NOT NULL,
  start TEXT NOT NULL,             -- ISO 8601 with offset
  end TEXT NOT NULL,
  description TEXT,
  account TEXT,                    -- calendar to create it on if approved; NULL = default
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed | approved | rejected
  calendar_event_id TEXT,          -- set once written to a calendar on approval
  calendar_account TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Owner's to-do list (Tasks tab). Tasks are never deleted: completing one sets status='done'.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'open',      -- open | done (never deleted)
  priority TEXT NOT NULL DEFAULT 'normal',  -- low | normal | high
  due_date TEXT,                            -- Central calendar date 'YYYY-MM-DD' or NULL
  created_by TEXT NOT NULL DEFAULT 'owner', -- 'owner' or 'agent:<slug>'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- "@Chief" action-mentions found on Files pages (see src/lib/chief-mentions.ts). One row per
-- distinct mention text per page; rows are never deleted ("present=0" = gone from the page,
-- status 'superseded' = edited before it ran). The result box lives ONLY here, never in docs.
CREATE TABLE IF NOT EXISTS page_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  mention_key TEXT NOT NULL,
  norm_text TEXT NOT NULL,
  mention_text TEXT NOT NULL,
  block_id TEXT,
  context TEXT,                                -- JSON {before:[], after:[]}
  page_title TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',      -- waiting | running | done | error | superseded | baseline
  present INTEGER NOT NULL DEFAULT 1,
  run_id INTEGER,
  result_text TEXT,
  result_links TEXT,                           -- JSON [{label, href}]
  error TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  briefed_at TEXT,
  UNIQUE(page_id, mention_key)
);
CREATE INDEX IF NOT EXISTS page_mentions_status ON page_mentions(status, page_id);
`);

// One-time seed of Owner's Personal Admin tasks. Guarded by an agent_state key so it never
// re-inserts, even if he later renames or completes a seeded task. Owner cell only: these are Owner's own tasks,
// and a member's fresh database must start empty (docs/multi-user.md "Member mode").
if (isOwnerCell() && !db.prepare(`SELECT 1 FROM agent_state WHERE key='tasks_seed_v1'`).get()) {
  // .immediate() takes the write lock up front and the guard is re-checked inside it, so two processes starting on a
  // fresh database together (e.g. `next build` workers) seed exactly once instead of one failing / doubling the tasks.
  db.transaction(() => {
    if (db.prepare(`SELECT 1 FROM agent_state WHERE key='tasks_seed_v1'`).get()) return;
    const ins = db.prepare(
      `INSERT INTO tasks (title, category, status, priority, due_date, created_by) VALUES (?, 'Personal Admin', 'open', 'normal', NULL, 'seed')`
    );
    for (const t of ["Renew license", "Amazon returns", "Cancel unused subscription", "CarrierCo switches", "Reply to the neighbor", "Health insurance call", "Life insurance call", "Update address"]) ins.run(t);
    db.prepare(`INSERT INTO agent_state (key, value) VALUES ('tasks_seed_v1', datetime('now'))`).run();
  }).immediate();
}

// Lightweight migration for columns added after initial release.
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("messages", "suggested_send_at", "suggested_send_at TEXT");
ensureColumn("chat_history", "attachments", "attachments TEXT");
ensureColumn("chat_history", "meta", "meta TEXT"); // review cards in chat: { type: "pr" | "text_draft", ... }
ensureColumn("schools", "stuck_reply_notified_at", "stuck_reply_notified_at TEXT");
ensureColumn("messages", "campaign", "campaign TEXT");
// Self-healing sends (additive): attempt counter, the Message-ID minted once per message (reused on
// every retry so a resend is detectable in Sent), and the last send error.
ensureColumn("messages", "send_attempts", "send_attempts INTEGER NOT NULL DEFAULT 0");
ensureColumn("messages", "send_message_id", "send_message_id TEXT");
ensureColumn("messages", "last_send_error", "last_send_error TEXT");
db.exec(`
CREATE TABLE IF NOT EXISTS mail_health (
  account TEXT PRIMARY KEY,
  status TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  last_ok_at TEXT,
  last_error TEXT,
  last_checked_at TEXT,
  down_since TEXT,
  alerted_at TEXT
);
`);
// Campaign "delete" is a reversible archive: nothing is removed. Archived messages get this
// timestamp so the Campaign tab hides them; see src/lib/campaign-archive.ts.
ensureColumn("messages", "campaign_archived_at", "campaign_archived_at TEXT");
// IMAP watch outage tracking (additive only): when an outage began, how many reconnects have
// failed in a row, the last real NOOP success, and when Owner was texted about this outage.
ensureColumn("imap_watch_state", "down_since", "down_since TEXT");
ensureColumn("imap_watch_state", "consecutive_failures", "consecutive_failures INTEGER DEFAULT 0");
ensureColumn("imap_watch_state", "last_ok_at", "last_ok_at TEXT");
ensureColumn("imap_watch_state", "down_alerted_at", "down_alerted_at TEXT");
db.exec(`
CREATE TABLE IF NOT EXISTS campaign_archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_key TEXT,
  label TEXT,
  archived_at TEXT DEFAULT (datetime('now')),
  restored_at TEXT
);
CREATE TABLE IF NOT EXISTS campaign_archive_items (
  archive_id INTEGER,
  message_id INTEGER,
  prev_status TEXT
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','active','archived')),
  page_id INTEGER,
  description TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
// Audit trail (additive only): triggers record who changed a school's/message's status or
// deleted one. No foreign keys, so audit rows survive the deletion they describe. The actor comes
// from the one-row audit_context (set by withAudit in src/lib/audit.ts); otherwise 'system'.
// An earlier draft of this feature created differently shaped tables (event/old_value/reason).
// CREATE TABLE IF NOT EXISTS would skip them and the inserts below would fail, so set them aside
// (renamed, never dropped) and let the current shape create itself.
if ((db.prepare(`PRAGMA table_info(status_audit)`).all() as { name: string }[]).some((c) => c.name === "event")) {
  db.exec(`
  DROP INDEX IF EXISTS idx_status_audit_school;
  DROP INDEX IF EXISTS idx_status_audit_created;
  DROP INDEX IF EXISTS idx_status_audit_entity;
  DROP TRIGGER IF EXISTS audit_school_status;
  DROP TRIGGER IF EXISTS audit_school_delete;
  DROP TRIGGER IF EXISTS audit_message_status;
  DROP TRIGGER IF EXISTS audit_message_delete;
  DROP TRIGGER IF EXISTS trg_audit_school_status;
  DROP TRIGGER IF EXISTS trg_audit_school_delete;
  DROP TRIGGER IF EXISTS trg_audit_message_status;
  DROP TRIGGER IF EXISTS trg_audit_message_delete;
  ALTER TABLE status_audit RENAME TO status_audit_v1;
  ALTER TABLE audit_context RENAME TO audit_context_v1;
  `);
}
db.exec(`
DROP TRIGGER IF EXISTS trg_audit_school_status;
DROP TRIGGER IF EXISTS trg_audit_school_delete;
DROP TRIGGER IF EXISTS trg_audit_message_status;
DROP TRIGGER IF EXISTS trg_audit_message_delete;
CREATE TABLE IF NOT EXISTS status_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,            -- 'school' | 'message'
  entity_id INTEGER NOT NULL,
  label TEXT,                      -- school name, or 'channel direction school_id=N'
  action TEXT NOT NULL,            -- 'status_change' | 'delete'
  old_status TEXT,
  new_status TEXT,
  actor TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_status_audit_entity ON status_audit(entity, entity_id);
CREATE TABLE IF NOT EXISTS audit_context (id INTEGER PRIMARY KEY CHECK (id = 1), actor TEXT, detail TEXT);
INSERT OR IGNORE INTO audit_context (id, actor, detail) VALUES (1, NULL, NULL);
CREATE TRIGGER IF NOT EXISTS audit_school_status AFTER UPDATE OF status ON schools WHEN OLD.status IS NOT NEW.status BEGIN
  INSERT INTO status_audit (entity, entity_id, label, action, old_status, new_status, actor, detail)
  VALUES ('school', NEW.id, NEW.name, 'status_change', OLD.status, NEW.status,
          COALESCE((SELECT actor FROM audit_context WHERE id=1), 'system'), (SELECT detail FROM audit_context WHERE id=1));
END;
CREATE TRIGGER IF NOT EXISTS audit_school_delete AFTER DELETE ON schools BEGIN
  INSERT INTO status_audit (entity, entity_id, label, action, old_status, new_status, actor, detail)
  VALUES ('school', OLD.id, OLD.name, 'delete', OLD.status, NULL,
          COALESCE((SELECT actor FROM audit_context WHERE id=1), 'system'), (SELECT detail FROM audit_context WHERE id=1));
END;
CREATE TRIGGER IF NOT EXISTS audit_message_status AFTER UPDATE OF status ON messages WHEN OLD.status IS NOT NEW.status BEGIN
  INSERT INTO status_audit (entity, entity_id, label, action, old_status, new_status, actor, detail)
  VALUES ('message', NEW.id, NEW.channel || ' ' || NEW.direction || ' school_id=' || NEW.school_id, 'status_change', OLD.status, NEW.status,
          COALESCE((SELECT actor FROM audit_context WHERE id=1), 'system'), (SELECT detail FROM audit_context WHERE id=1));
END;
CREATE TRIGGER IF NOT EXISTS audit_message_delete AFTER DELETE ON messages BEGIN
  INSERT INTO status_audit (entity, entity_id, label, action, old_status, new_status, actor, detail)
  VALUES ('message', OLD.id, OLD.channel || ' ' || OLD.direction || ' school_id=' || OLD.school_id, 'delete', OLD.status, NULL,
          COALESCE((SELECT actor FROM audit_context WHERE id=1), 'system'), (SELECT detail FROM audit_context WHERE id=1));
END;
`);

export type PurgeBogusInboundResult = {
  deletedInbound: number;
  deletedMessages: number;
  restoredFollowups: number;
  status: string;
};

/**
 * Deletes inbound_emails rows for a school that aren't from its real contact address (bogus /
 * mis-matched "replies"), the messages rows created from them, restores any outbound follow-up
 * that got wrongly auto-cancelled as a result, and recomputes the school's status. Returns null
 * if the school doesn't exist. If the school has no contact_email on file, does nothing (can't
 * tell genuine from bogus, so never deletes). Idempotent - a second call with nothing bogus left
 * returns all zeros. Contract proven by e2e/school22-purge-migration.spec.ts.
 */
export function purgeBogusInboundRows(schoolId: number): PurgeBogusInboundResult | null {
  const school = db
    .prepare(`SELECT id, contact_email, status FROM schools WHERE id = ?`)
    .get(schoolId) as { id: number; contact_email: string | null; status: string } | undefined;
  if (!school) return null;
  if (!school.contact_email) {
    return { deletedInbound: 0, deletedMessages: 0, restoredFollowups: 0, status: school.status };
  }
  const contact = school.contact_email.toLowerCase();

  const bogus = db
    .prepare(`SELECT id, subject, body FROM inbound_emails WHERE school_id = ? AND LOWER(from_address) != ?`)
    .all(schoolId, contact) as { id: number; subject: string | null; body: string | null }[];

  let deletedMessages = 0;
  for (const row of bogus) {
    deletedMessages += db
      .prepare(`DELETE FROM messages WHERE school_id = ? AND direction = 'inbound' AND subject IS ? AND body IS ?`)
      .run(schoolId, row.subject, row.body).changes;
  }

  const deletedInbound = db
    .prepare(`DELETE FROM inbound_emails WHERE school_id = ? AND LOWER(from_address) != ?`)
    .run(schoolId, contact).changes;

  const restoredFollowups = db
    .prepare(`UPDATE messages SET status = 'scheduled' WHERE school_id = ? AND direction = 'outbound' AND status = 'cancelled' AND campaign_archived_at IS NULL`)
    .run(schoolId).changes;

  const remainingInbound = (
    db.prepare(`SELECT COUNT(*) as c FROM inbound_emails WHERE school_id = ?`).get(schoolId) as { c: number }
  ).c;
  const status = remainingInbound > 0 ? "replied" : "contacted";
  db.prepare(`UPDATE schools SET status = ? WHERE id = ?`).run(status, schoolId);

  return { deletedInbound, deletedMessages, restoredFollowups, status };
}

// One-time startup migration for escalation #5 / proposal #14: school_id 22 (True North Academy)
// accumulated ~79 bogus inbound_emails rows before a matching bug (unrelated personal email
// threads mis-matched to a school) was fixed. The original cleanup was a standalone script, but
// no agent in this system has shell access to run one — so it runs here instead, once,
// automatically, on every server start. Idempotent: once the rows are gone this is a no-op.
// Both one-off repairs below are about rows in Owner's own database, so they run only in the owner cell
// (docs/multi-user.md "Member mode"); in a member cell they'd create a stray "page 399" page in that user's OS.
if (isOwnerCell()) purgeBogusInboundRows(22);

// One-time startup recovery: copies every saved earlier version of page 399 into a NEW page.
// Backs up first, never writes to docs row 399, idempotent. Async so the module cycle with
// backup.ts is resolved by the time it runs; failures are logged and never block startup.
if (isOwnerCell()) void import("./recover-page-399")
  .then(async (m) => {
    await m.recoverPage399(db);
    // Follow-up: append 10/26+ snapshots (undo log, backups) to the recovery page. Backs up first.
    await m.recoverPage399Followup(db);
  })
  .catch((err) => console.error("recover-page-399 failed:", err));

// One-time migration: message_changelog was originally created without ON DELETE CASCADE.
// SQLite can't ALTER a foreign key's action, so if the live table predates that fix, rebuild it.
{
  const def = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='message_changelog'`).get() as { sql: string } | undefined)?.sql;
  if (def && !/ON DELETE CASCADE/i.test(def)) {
    db.exec(`
      ALTER TABLE message_changelog RENAME TO message_changelog_old;
      CREATE TABLE message_changelog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO message_changelog SELECT * FROM message_changelog_old;
      DROP TABLE message_changelog_old;
    `);
  }
}


// One-time cleanup for rows saved before HTML entities were decoded on write
// (e.g. "Founder &amp; Lead Educator"). Idempotent: re-running finds nothing to fix.
db.exec(`UPDATE schools SET name = REPLACE(name, '&amp;', '&') WHERE name LIKE '%&amp;%'`);
db.exec(
  `UPDATE schools SET contact_name = REPLACE(contact_name, '&amp;', '&') WHERE contact_name LIKE '%&amp;%'`
);

// --- OS login (additive). Snapshot the DB once before these tables first appear.
if (!underTest && !db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_settings'`).get()) {
  try {
    const dir = path.join(dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `pre-auth-${new Date().toISOString().slice(0, 10)}.db`);
    if (!fs.existsSync(dest)) db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } catch (e) { console.error("pre-auth backup failed (tables are new and empty, continuing)", e); }
}
db.exec(`
CREATE TABLE IF NOT EXISTS auth_settings (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT, totp_secret_enc TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_last_step INTEGER NOT NULL DEFAULT 0, enrolled_at INTEGER, enforce INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS auth_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER, ip TEXT, user_agent TEXT, method TEXT);
CREATE TABLE IF NOT EXISTS auth_backup_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, code_hash TEXT NOT NULL, batch INTEGER NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER, replaced_at INTEGER);
CREATE TABLE IF NOT EXISTS auth_challenges (id INTEGER PRIMARY KEY AUTOINCREMENT, challenge_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER, ip TEXT);
CREATE TABLE IF NOT EXISTS auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ok INTEGER NOT NULL, ip TEXT, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_auth_events_at ON auth_events(at);
`);

// --- Page version history (additive). Snapshot the DB once before the table first appears.
if (!underTest && !db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='page_versions'`).get()) {
  try {
    const dir = path.join(dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `pre-page-versions-${new Date().toISOString().slice(0, 10)}.db`);
    if (!fs.existsSync(dest)) db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } catch (e) { console.error("pre-page-versions backup failed (table is new and empty, continuing)", e); }
}
db.exec(`
CREATE TABLE IF NOT EXISTS page_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  title TEXT,
  body TEXT,
  content TEXT,
  source TEXT NOT NULL CHECK (source IN ('agent','ui','organize','undo')),
  agent_slug TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_page_versions_page ON page_versions(page_id, id);
`);

export default db;

/** Additive schema rule (CLAUDE.md): snapshot the live DB once before any of `tables` first
 *  appears. Same VACUUM INTO pattern as page_versions above; skipped under tests (throwaway DB).
 *  A failed snapshot only logs: the tables being added are new and empty. */
export function snapshotBeforeNewTables(tag: string, tables: string[]) {
  if (underTest) return;
  const missing = tables.some((t) => !db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t));
  if (!missing) return;
  try {
    const dir = path.join(dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `pre-${tag}-${new Date().toISOString().slice(0, 10)}.db`);
    if (!fs.existsSync(dest)) db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } catch (e) {
    console.error(`pre-${tag} backup failed (tables are new and empty, continuing)`, e);
  }
}

const ISSUE_GROUP_THRESHOLD = 15;

export function logIssue(source: string, message: string, detail?: unknown): void {
  if (!message.startsWith("Grouped:")) {
    const c = db
      .prepare(`SELECT COUNT(*) AS n FROM issues WHERE source=? AND status='open' AND message NOT LIKE 'Grouped:%'`)
      .get(source) as { n: number };
    if (c.n >= ISSUE_GROUP_THRESHOLD) {
      const gm = `Grouped: ${source} has many open alerts (new ones are being collapsed)`;
      const row = db
        .prepare(`SELECT id, detail FROM issues WHERE source=? AND message=? AND status='open' LIMIT 1`)
        .get(source, gm) as { id: number; detail: string | null } | undefined;
      let suppressed = 0;
      try {
        suppressed = Number((JSON.parse(row?.detail || "{}") as { suppressed?: number }).suppressed) || 0;
      } catch {
        suppressed = 0;
      }
      const d = JSON.stringify({ suppressed: suppressed + 1, last_seen: new Date().toISOString(), last_message: message.slice(0, 200) });
      if (row) db.prepare(`UPDATE issues SET detail=? WHERE id=?`).run(d, row.id);
      else db.prepare(`INSERT INTO issues (source, message, detail) VALUES (?, ?, ?)`).run(source, gm, d);
      return;
    }
  }
  db.prepare(`INSERT INTO issues (source, message, detail) VALUES (?, ?, ?)`).run(
    source,
    message,
    detail ? JSON.stringify(detail) : null
  );
}

// Small durable key/value store for agent bookkeeping (e.g. the last processed
// iMessage ROWID, so an inbound-text pass never re-reads the same message twice).
export function getState(key: string): string | null {
  const row = db.prepare(`SELECT value FROM agent_state WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setState(key: string, value: string) {
  db.prepare(
    `INSERT INTO agent_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export type School = {
  id: number;
  name: string;
  website: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  linkedin_url: string | null;
  facebook_url: string | null;
  notes: string | null;
  status: string;
  created_at: string;
};

export type Message = {
  id: number;
  school_id: number;
  channel: string;
  direction: string;
  step: string;
  subject: string | null;
  body: string;
  status: string;
  scheduled_for: string | null;
  suggested_send_at: string | null;
  sent_at: string | null;
  from_address: string | null;
  message_ref: string | null;
  campaign: string | null;
  send_attempts?: number;
  send_message_id?: string | null;
  last_send_error?: string | null;
  created_at: string;
};

export type Doc = {
  id: number;
  title: string;
  body: string;
  category: string;
  created_by: "owner" | "agent";
  created_at: string;
  updated_at: string;
};

export type MailAccountRow = {
  id: number;
  email: string;
  label: string | null;
  kind: "gmail_oauth" | "legacy_app_password";
  refresh_token: string | null;
  scopes: string | null;
  status: string;
  connected_at: string;
};

export type TextDraft = {
  id: number;
  to_handle: string | null;
  chat_guid: string | null;
  contact_name: string | null;
  text: string;
  reason: string | null;
  suggested_send_at: string | null;
  status: string;
  approved_by: string | null;
  send_id: number | null;
  created_at: string;
};

export type AllowlistEntry = {
  id: number;
  handle: string;
  label: string | null;
  created_at: string;
};

export type EmailClassification =
  | "wants_meeting"
  | "wants_info"
  | "objection"
  | "decline"
  | "out_of_office"
  | "other";

export type InboundEmailRow = {
  id: number;
  account: string;
  message_id: string;
  uid: number | null;
  from_address: string;
  to_address: string | null;
  subject: string | null;
  body: string;
  school_id: number | null;
  classification: EmailClassification;
  skip_reason: string | null;
  notify_needed: 0 | 1;
  agent_status: "pending" | "processing" | "done" | "skipped";
  agent_summary: string | null;
  reminded_at: string | null;
  created_at: string;
};

export type ImapWatchStateRow = {
  account: string;
  last_uid: number;
  status: "idle" | "watching" | "error";
  last_seen_at: string | null;
  last_error: string | null;
  updated_at: string;
};

export type ScheduleItemRow = {
  id: number;
  date: string;
  title: string;
  start: string;
  end: string;
  description: string | null;
  account: string | null;
  reason: string | null;
  status: "proposed" | "approved" | "rejected";
  calendar_event_id: string | null;
  calendar_account: string | null;
  created_at: string;
};

/** Has this job already completed for this key? Used so a daily/per-event job never double-runs
 *  (a catch-up check after a restart, an overlapping cron tick, ...). */
export function jobAlreadyRan(job: string, runKey: string): boolean {
  return !!db.prepare(`SELECT 1 FROM job_runs WHERE job=? AND run_key=? AND status='done'`).get(job, runKey);
}

export function recordJobRun(job: string, runKey: string, status: "done" | "failed" = "done") {
  db.prepare(
    `INSERT INTO job_runs (job, run_key, status) VALUES (?, ?, ?)
     ON CONFLICT(job, run_key) DO UPDATE SET status=excluded.status, created_at=datetime('now')`
  ).run(job, runKey, status);
}

// One-time merge: label every unlabelled pending/approved/scheduled outbound message with one
// campaign name so the Campaign tab shows a single card. Only sets a label (never overwrites an
// existing campaign), runs exactly once (guarded by an agent_state key), logs each row.
{
  const NAME = "Sept 29 week outreach";
  const KEY = "migration:campaign-sept29-week-outreach-v1";
  if (!getState(KEY)) {
    const ids = db
      .prepare(
        `SELECT m.id FROM messages m JOIN schools s ON s.id = m.school_id
         WHERE m.direction='outbound' AND m.status IN ('pending_approval','approved','scheduled')
           AND (m.campaign IS NULL OR m.campaign='') AND s.name NOT LIKE 'E2E %'`
      )
      .all() as { id: number }[];
    db.transaction(() => {
      const upd = db.prepare(`UPDATE messages SET campaign=? WHERE id=?`);
      const log = db.prepare(`INSERT INTO message_changelog (message_id,event,detail) VALUES (?,?,?)`);
      for (const { id } of ids) {
        upd.run(NAME, id);
        log.run(id, "campaign", `campaign set to "${NAME}" (one-time merge)`);
      }
      setState(KEY, `${ids.length} messages`);
    })();
  }
}

// One-time seed of the campaign registry (additive; never overwrites an existing row).
{
  const KEY = "migration:campaign-registry-property-management-v1";
  if (isOwnerCell() && !getState(KEY)) { // Owner's campaign: owner cell only
    db.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO campaigns (name,status,page_id,description,created_by) VALUES (?,?,?,?,?)`
      ).run(
        "Property Management",
        "planning",
        282,
        "On hold: planning only. 10 pitch angles on the strategy page. No drafts until Owner says go.",
        "seed"
      );
      setState(KEY, "seeded");
    })();
  }
}
