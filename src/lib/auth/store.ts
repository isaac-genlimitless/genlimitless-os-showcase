import db from "../accounts/db";
import { getUser } from "../accounts/users";
import { currentUserId, ownsAccounts } from "../accounts/identity";
import {
  MIN_PASSWORD_LENGTH, hashPassword, verifyPassword, generateBackupCodes, normalizeBackupCode,
  hmacHex, sha256Hex, newToken, newTotpSecret, otpauthUri, encryptSecret, decryptSecret, verifyTotp,
} from "./crypto";

// Everything here is per user_id and lives in accounts.db. No function reads or writes another user's rows.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const SEEN_INTERVAL_MS = 5 * 60 * 1000;

interface SettingsRow {
  password_hash: string | null;
  totp_secret_enc: string | null;
  totp_enabled: number;
  totp_last_step: number;
  enrolled_at: number | null;
  enforce: number;
}

function row(userId: string): SettingsRow | undefined {
  return db.prepare(`SELECT password_hash, totp_secret_enc, totp_enabled, totp_last_step, enrolled_at, enforce FROM auth_credentials WHERE user_id = ?`).get(userId) as SettingsRow | undefined;
}

function ensureRow(userId: string): void {
  if (!getUser(userId)) throw new Error("unknown_user");
  db.prepare(`INSERT OR IGNORE INTO auth_credentials (user_id, updated_at) VALUES (?, ?)`).run(userId, Date.now());
}

export function getAuthState(userId: string): { enrolled: boolean; enforce: boolean; totpEnabled: boolean; hasPassword: boolean } {
  const r = row(userId);
  if (!r) return { enrolled: false, enforce: false, totpEnabled: false, hasPassword: false };
  return { enrolled: !!r.enrolled_at, enforce: !!r.enforce, totpEnabled: !!r.totp_enabled, hasPassword: !!r.password_hash };
}

export function setPassword(userId: string, pw: string): void {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD_LENGTH) throw new Error("too_short");
  ensureRow(userId);
  db.prepare(`UPDATE auth_credentials SET password_hash = ?, updated_at = ? WHERE user_id = ?`).run(hashPassword(pw), Date.now(), userId);
}

export function checkPassword(userId: string, pw: string): boolean {
  const r = row(userId);
  if (!r || !r.password_hash) return false;
  return verifyPassword(pw, r.password_hash);
}

/** Burn the same time as a real check, so an unknown name and a wrong password look alike. */
const DUMMY_HASH = hashPassword("not-a-real-password-for-timing");
export function checkPasswordDummy(pw: string): void {
  verifyPassword(pw, DUMMY_HASH);
}

export function replaceBackupCodes(userId: string): string[] {
  const now = Date.now();
  const codes = generateBackupCodes(10);
  const tx = db.transaction(() => {
    db.prepare(`UPDATE auth_backup_codes SET replaced_at = ? WHERE user_id = ? AND used_at IS NULL AND replaced_at IS NULL`).run(now, userId);
    const ins = db.prepare(`INSERT INTO auth_backup_codes (user_id, code_hash, batch, created_at) VALUES (?, ?, ?, ?)`);
    for (const c of codes) ins.run(userId, hmacHex(normalizeBackupCode(c)), now, now);
  });
  tx();
  return codes;
}

export function completeEnrollment(userId: string): string[] {
  ensureRow(userId);
  db.prepare(`UPDATE auth_credentials SET enrolled_at = ?, updated_at = ? WHERE user_id = ?`).run(Date.now(), Date.now(), userId);
  return replaceBackupCodes(userId);
}

export function consumeBackupCode(userId: string, code: string): boolean {
  const h = hmacHex(normalizeBackupCode(code));
  const res = db.prepare(`UPDATE auth_backup_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL AND replaced_at IS NULL`).run(Date.now(), userId, h);
  return res.changes > 0;
}

export function unusedBackupCodeCount(userId: string): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM auth_backup_codes WHERE user_id = ? AND used_at IS NULL AND replaced_at IS NULL`).get(userId) as { n: number };
  return r.n;
}

export function createChallenge(userId: string, ip: string): string {
  if (!getUser(userId)) throw new Error("unknown_user");
  const id = newToken();
  const now = Date.now();
  db.prepare(`INSERT INTO auth_challenges (user_id, challenge_hash, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)`).run(userId, sha256Hex(id), now, now + CHALLENGE_TTL_MS, ip);
  return id;
}

/** The user a still-open challenge belongs to, or null. */
export function challengeUser(id: string): string | null {
  if (!id) return null;
  const r = db.prepare(`SELECT user_id FROM auth_challenges WHERE challenge_hash = ? AND completed_at IS NULL AND expires_at > ?`).get(sha256Hex(id), Date.now()) as { user_id: string } | undefined;
  return r ? r.user_id : null;
}

export function challengeValid(id: string): boolean {
  return challengeUser(id) !== null;
}

export function completeChallenge(id: string): void {
  db.prepare(`UPDATE auth_challenges SET completed_at = ? WHERE challenge_hash = ?`).run(Date.now(), sha256Hex(id));
}

export function createSession(userId: string, meta: { ip: string; userAgent: string; method: string }): { token: string; expiresAt: number } {
  if (!getUser(userId)) throw new Error("unknown_user");
  const token = newToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare(`INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, sha256Hex(token), now, expiresAt, now, meta.ip, meta.userAgent, meta.method);
  return { token, expiresAt };
}

export type SessionCheck =
  | { result: "invalid" }
  | { result: "valid" | "slid"; userId: string; imp?: { by: string; readOnly: boolean } };

/** Looks the cookie up in accounts.db. Valid only for an active user. Slides the expiry like before
 *  (never for an impersonation session: those keep their hard expiry). `nowMs` is for tests. */
export function checkSession(token: string | undefined, nowMs?: number): SessionCheck {
  if (!token) return { result: "invalid" };
  const now = nowMs ?? Date.now();
  const h = sha256Hex(token);
  const r = db
    .prepare(
      `SELECT s.id, s.user_id, s.last_seen_at, s.impersonator_id, s.read_only FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'`
    )
    .get(h, now) as { id: number; user_id: string; last_seen_at: number | null; impersonator_id: string | null; read_only: number | null } | undefined;
  if (!r) return { result: "invalid" };
  if (r.impersonator_id) {
    return { result: "valid", userId: r.user_id, imp: { by: r.impersonator_id, readOnly: !!r.read_only } };
  }
  if (!r.last_seen_at || now - r.last_seen_at > SEEN_INTERVAL_MS) {
    db.prepare(`UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`).run(now, now + SESSION_TTL_MS, r.id);
    return { result: "slid", userId: r.user_id };
  }
  return { result: "valid", userId: r.user_id };
}

/** The signed-in user's slug, or null. */
export function sessionUserId(token: string | undefined): string | null {
  const c = checkSession(token);
  return c.result === "invalid" ? null : c.userId;
}

/** True only for a live session of THIS cell's user (callers outside auth, e.g. preview links, use this). */
export function validateSession(token: string | undefined): boolean {
  if (!ownsAccounts()) return false; // member cells never open accounts.db; their proxy asks the owner cell
  const uid = sessionUserId(token);
  return uid !== null && uid === currentUserId();
}

export function revokeSession(token: string): void {
  db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`).run(Date.now(), sha256Hex(token));
}

export function revokeOtherSessions(userId: string, keepToken: string): number {
  const res = db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND token_hash != ? AND revoked_at IS NULL`).run(Date.now(), userId, sha256Hex(keepToken));
  return res.changes;
}

/** Sign a user out everywhere (used when an account is disabled). */
export function revokeAllSessions(userId: string): number {
  return db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(Date.now(), userId).changes;
}

export function listSessions(userId: string, currentToken?: string): { id: number; created_at: number; last_seen_at: number | null; ip: string | null; user_agent: string | null; current?: boolean }[] {
  const rows = db.prepare(`SELECT id, created_at, last_seen_at, ip, user_agent, token_hash FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`).all(userId, Date.now()) as { id: number; created_at: number; last_seen_at: number | null; ip: string | null; user_agent: string | null; token_hash: string }[];
  const cur = currentToken ? sha256Hex(currentToken) : "";
  return rows.map((r) => ({
    id: r.id, created_at: r.created_at, last_seen_at: r.last_seen_at, ip: r.ip, user_agent: r.user_agent,
    current: cur !== "" && r.token_hash === cur,
  }));
}

export function beginTotp(userId: string): { secret: string; uri: string } {
  const secret = newTotpSecret();
  ensureRow(userId);
  db.prepare(`UPDATE auth_credentials SET totp_secret_enc = ?, totp_enabled = 0, totp_last_step = 0, updated_at = ? WHERE user_id = ?`).run(encryptSecret(secret), Date.now(), userId);
  return { secret, uri: otpauthUri(secret, getUser(userId)?.display_name || userId) };
}

export function confirmTotp(userId: string, code: string): boolean {
  const r = row(userId);
  if (!r || !r.totp_secret_enc) return false;
  const step = verifyTotp(decryptSecret(r.totp_secret_enc), code, Date.now(), r.totp_last_step);
  if (step === null) return false;
  db.prepare(`UPDATE auth_credentials SET totp_enabled = 1, totp_last_step = ?, updated_at = ? WHERE user_id = ?`).run(step, Date.now(), userId);
  return true;
}

export function disableTotp(userId: string): void {
  db.prepare(`UPDATE auth_credentials SET totp_enabled = 0, updated_at = ? WHERE user_id = ?`).run(Date.now(), userId);
}

export function checkTotp(userId: string, code: string): boolean {
  const r = row(userId);
  if (!r || !r.totp_enabled || !r.totp_secret_enc) return false;
  const step = verifyTotp(decryptSecret(r.totp_secret_enc), code, Date.now(), r.totp_last_step);
  if (step === null) return false;
  db.prepare(`UPDATE auth_credentials SET totp_last_step = ? WHERE user_id = ?`).run(step, userId);
  return true;
}

export function setEnforce(userId: string, on: boolean): void {
  const r = row(userId);
  if (on && (!r || !r.enrolled_at)) throw new Error("not_enrolled");
  ensureRow(userId);
  db.prepare(`UPDATE auth_credentials SET enforce = ?, updated_at = ? WHERE user_id = ?`).run(on ? 1 : 0, Date.now(), userId);
}

export function recordAuthEvent(kind: string, ok: boolean, ip: string, userId: string | null = null): void {
  db.prepare(`INSERT INTO auth_events (user_id, kind, ok, ip, at) VALUES (?, ?, ?, ?, ?)`).run(userId, kind, ok ? 1 : 0, ip, Date.now());
}

export function tooManyFailures(ip: string, userId?: string | null): boolean {
  const now = Date.now();
  const a = db.prepare(`SELECT COUNT(*) AS n FROM auth_events WHERE ok = 0 AND ip = ? AND at > ?`).get(ip, now - 15 * 60 * 1000) as { n: number };
  if (a.n >= 5) return true;
  const b = db.prepare(`SELECT COUNT(*) AS n FROM auth_events WHERE ok = 0 AND at > ?`).get(now - 60 * 60 * 1000) as { n: number };
  if (b.n >= 30) return true;
  if (userId) {
    const c = db.prepare(`SELECT COUNT(*) AS n FROM auth_events WHERE ok = 0 AND user_id = ? AND at > ?`).get(userId, now - 60 * 60 * 1000) as { n: number };
    if (c.n >= 15) return true;
  }
  return false;
}
