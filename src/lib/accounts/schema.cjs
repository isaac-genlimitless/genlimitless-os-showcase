// The accounts.db schema, shared by src/lib/accounts/db.ts and scripts/accounts-migrate.mjs (plain CommonJS so the app, the migration script and the test runner can all load it).
const ACCOUNTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                       -- slug, e.g. 'owner'
  display_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  port INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  password_hash TEXT,
  totp_secret_enc TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  enrolled_at INTEGER,
  enforce INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_backup_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  batch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  replaced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_backup_user ON auth_backup_codes(user_id, code_hash);
CREATE TABLE IF NOT EXISTS auth_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  challenge_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  ip TEXT,
  user_agent TEXT,
  method TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
CREATE TABLE IF NOT EXISTS auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,                               -- NULL for failed logins with an unknown user
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  ip TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_events_at ON auth_events(at);
CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  challenge_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_codes_challenge ON login_codes(challenge_id);
CREATE INDEX IF NOT EXISTS idx_login_codes_user ON login_codes(user_id, created_at);
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL REFERENCES users(id),
  grantee_id TEXT NOT NULL REFERENCES users(id),
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read','edit')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shares_grantee ON shares(grantee_id);
CREATE TABLE IF NOT EXISTS auth_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,            -- sha256 of the one-time setup link's token; the token itself is never stored
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invites_user ON auth_invites(user_id);
`;

module.exports = { ACCOUNTS_SCHEMA };
