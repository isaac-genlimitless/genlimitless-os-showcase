import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { execFileSync, spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { hashPassword, verifyPassword, generateBackupCodes, hmacHex, normalizeBackupCode } from "../src/lib/auth/crypto";

// Runs scripts/accounts-migrate.mjs on a throwaway fixture. It never sees the real data folder, sends nothing and
// never triggers the agent.

const SCRIPT = path.join(__dirname, "..", "scripts", "accounts-migrate.mjs");
const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
const fileSha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ACCOUNTS_DIR: "", OWNER_IMESSAGE_HANDLE: "" } });
}

test("accounts-migrate: dry run by default, read-only, idempotent, keeps Owner's login", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genlimitless-e2e-data-migrate-"));
  const accDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "glos-accounts-e2e-migrate-")), "accounts");
  const dbPath = path.join(dataDir, ["genlimitless", "db"].join("."));
  const now = Date.now();
  const DAY = 86_400_000;
  const pw = "correct horse battery staple";
  const goodToken = "good-session-token";
  const codes = generateBackupCodes(3);

  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE auth_settings (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT, totp_secret_enc TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_last_step INTEGER NOT NULL DEFAULT 0, enrolled_at INTEGER, enforce INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);
    CREATE TABLE auth_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER, ip TEXT, user_agent TEXT, method TEXT);
    CREATE TABLE auth_backup_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, code_hash TEXT NOT NULL, batch INTEGER NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER, replaced_at INTEGER);
  `);
  old.prepare(`INSERT INTO auth_settings VALUES (1, ?, 'enc.secret.x', 1, 42, ?, 1, ?)`).run(hashPassword(pw), now - DAY, now);
  const ins = old.prepare(`INSERT INTO auth_sessions (token_hash, created_at, expires_at, last_seen_at, revoked_at, ip, user_agent, method) VALUES (?, ?, ?, ?, ?, 'ip', 'ua', 'totp')`);
  ins.run(sha(goodToken), now - DAY, now + 5 * DAY, now, null);
  ins.run(sha("expired"), now - 40 * DAY, now - DAY, now - 2 * DAY, null);
  ins.run(sha("revoked"), now - DAY, now + 5 * DAY, now, now - 1000);
  const insCode = old.prepare(`INSERT INTO auth_backup_codes (code_hash, batch, created_at, used_at) VALUES (?, 1, ?, ?)`);
  codes.forEach((c, i) => insCode.run(hmacHex(normalizeBackupCode(c)), now, i === 2 ? now : null));
  old.close();
  fs.writeFileSync(path.join(dataDir, "auth-secret.key"), "legacy-secret-abc\n");
  const before = fileSha(dbPath);

  // dry run (default): writes nothing at all
  const dry = run(["--data-dir", dataDir, "--accounts-dir", accDir]);
  expect(dry.status, dry.stderr).toBe(0);
  expect(dry.stdout).toContain("DRY RUN");
  expect(fs.existsSync(accDir)).toBe(false);

  // --apply alone is refused (backup must be confirmed)
  expect(run(["--data-dir", dataDir, "--accounts-dir", accDir, "--apply"]).status).not.toBe(0);
  expect(fs.existsSync(accDir)).toBe(false);

  // apply, twice
  for (let i = 0; i < 2; i++) {
    const r = run(["--data-dir", dataDir, "--accounts-dir", accDir, "--apply", "--backup-done", "--phone", "+15555550123"]);
    expect(r.status, r.stderr).toBe(0);
  }
  const acc = new Database(path.join(accDir, "accounts.db"), { readonly: true });
  const user = acc.prepare(`SELECT * FROM users WHERE id='owner'`).get() as Record<string, unknown>;
  expect(user).toMatchObject({ role: "owner", port: 3100, status: "active", phone: "+15555550123" });
  const cred = acc.prepare(`SELECT * FROM auth_credentials WHERE user_id='owner'`).get() as Record<string, unknown> & { password_hash: string };
  expect(verifyPassword(pw, cred.password_hash)).toBe(true);
  expect(cred).toMatchObject({ totp_enabled: 1, totp_last_step: 42, enforce: 1, totp_secret_enc: "enc.secret.x" });
  const kept = acc.prepare(`SELECT code_hash, used_at FROM auth_backup_codes WHERE user_id='owner' ORDER BY id`).all() as { code_hash: string; used_at: number | null }[];
  expect(kept).toHaveLength(3);
  expect(kept[0].code_hash).toBe(hmacHex(normalizeBackupCode(codes[0])));
  expect(kept[2].used_at).not.toBeNull();
  const sess = acc.prepare(`SELECT token_hash FROM auth_sessions WHERE user_id='owner' AND revoked_at IS NULL AND expires_at > ?`).all(now) as { token_hash: string }[];
  expect(sess.map((s) => s.token_hash)).toEqual([sha(goodToken)]); // expired and revoked ones were not copied
  acc.close();
  expect(fs.readFileSync(path.join(accDir, "auth-secret.key"), "utf8").trim()).toBe("legacy-secret-abc");

  // the old database is byte-for-byte what it was (opened read-only, nothing altered)
  expect(fileSha(dbPath)).toBe(before);
  expect(fs.existsSync(dbPath + "-wal")).toBe(false);

  // a different secret already in place is a hard stop, not a silent overwrite
  fs.writeFileSync(path.join(accDir, "auth-secret.key"), "someone-elses-secret");
  const clash = run(["--data-dir", dataDir, "--accounts-dir", accDir, "--apply", "--backup-done"]);
  expect(clash.status).not.toBe(0);
  expect(clash.stderr).toContain("differs");
  void execFileSync;
});
