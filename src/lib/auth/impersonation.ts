import db from "../accounts/db";
import { getUser } from "../accounts/users";
import { newToken, sha256Hex } from "./crypto";
import { checkSession, revokeSession } from "./store";

// Read-only "view as" sessions. An impersonation session is a normal auth_sessions row for the TARGET user
// with impersonator_id set. Needs part 1's auth_sessions columns (impersonator_id, read_only) and admin_audit.

export const IMPERSONATION_TTL_MS = 30 * 60 * 1000;

let auditReady = false;
function audit(actor: string, action: string, target: string | null, detail: Record<string, unknown>, at: number): void {
  if (!auditReady) {
    db.exec(`CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, at INTEGER NOT NULL)`);
    auditReady = true;
  }
  db.prepare(`INSERT INTO admin_audit (actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?)`)
    .run(actor, action, target, JSON.stringify(detail), at);
}

/** Revoke expired, unrevoked impersonation sessions and log exactly one 'impersonate_expired' row each. */
export function sweepExpired(now: number = Date.now()): number {
  const rows = db.prepare(
    `SELECT id, user_id, impersonator_id, expires_at FROM auth_sessions
     WHERE impersonator_id IS NOT NULL AND revoked_at IS NULL AND expires_at <= ?`
  ).all(now) as { id: number; user_id: string; impersonator_id: string; expires_at: number }[];
  const tx = db.transaction(() => {
    for (const r of rows) {
      const res = db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now, r.id);
      if (res.changes > 0) audit(r.impersonator_id, "impersonate_expired", r.user_id, { expires_at: r.expires_at }, now);
    }
  });
  tx();
  return rows.length;
}

export type StartResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; status: number; reason: string };

export function startImpersonation(
  adminToken: string | undefined,
  targetId: string,
  meta: { ip: string; userAgent: string },
  now: number = Date.now()
): StartResult {
  sweepExpired(now);
  const cur = checkSession(adminToken, now);
  if (cur.result === "invalid") return { ok: false, status: 403, reason: "Sign in first." };
  if (cur.imp) return { ok: false, status: 403, reason: "Stop the current view-as session first." };
  const admin = getUser(cur.userId) as (ReturnType<typeof getUser> & { removed_at?: number | null }) | undefined;
  if (!admin || admin.status !== "active" || admin.removed_at || admin.role !== "owner") {
    return { ok: false, status: 403, reason: "Only an admin can view as another user." };
  }
  if (typeof targetId !== "string" || !targetId) return { ok: false, status: 400, reason: "Pick a user." };
  if (targetId === admin.id) return { ok: false, status: 400, reason: "You can't view as yourself." };
  const target = getUser(targetId) as (ReturnType<typeof getUser> & { removed_at?: number | null }) | undefined;
  if (!target) return { ok: false, status: 400, reason: "No such user." };
  if (target.removed_at) return { ok: false, status: 400, reason: "That user was removed." };
  if (target.status !== "active") return { ok: false, status: 400, reason: "That user is disabled." };
  if (target.role !== "member") return { ok: false, status: 400, reason: "You can only view as a member." };

  const token = newToken();
  const expiresAt = now + IMPERSONATION_TTL_MS;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE impersonator_id = ? AND revoked_at IS NULL`).run(now, admin.id);
    db.prepare(
      `INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent, method, impersonator_id, read_only)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'impersonation', ?, 1)`
    ).run(target.id, sha256Hex(token), now, expiresAt, now, meta.ip, meta.userAgent, admin.id);
    audit(admin.id, "impersonate_start", target.id, { ip: meta.ip, expires_at: expiresAt }, now);
  });
  tx();
  return { ok: true, token, expiresAt };
}

/** Revokes an impersonation session (and only an impersonation session). Returns the admin id it belonged to. */
export function stopImpersonation(token: string | undefined, now: number = Date.now()): { by: string; as: string } | null {
  sweepExpired(now);
  if (!token) return null;
  const r = db.prepare(
    `SELECT user_id, impersonator_id FROM auth_sessions WHERE token_hash = ? AND impersonator_id IS NOT NULL AND revoked_at IS NULL`
  ).get(sha256Hex(token)) as { user_id: string; impersonator_id: string } | undefined;
  if (!r) return null;
  revokeSession(token);
  audit(r.impersonator_id, "impersonate_stop", r.user_id, {}, now);
  return { by: r.impersonator_id, as: r.user_id };
}

export type ImpersonationStatus =
  | { active: false }
  | { active: true; as: string; as_name: string; by: string; expires_at: number; read_only: boolean };

export function impersonationStatus(token: string | undefined, now: number = Date.now()): ImpersonationStatus {
  sweepExpired(now);
  const c = checkSession(token, now);
  if (c.result === "invalid" || !c.imp || !token) return { active: false };
  const r = db.prepare(`SELECT expires_at FROM auth_sessions WHERE token_hash = ?`).get(sha256Hex(token)) as { expires_at: number } | undefined;
  if (!r) return { active: false };
  const u = getUser(c.userId);
  return { active: true, as: c.userId, as_name: u?.display_name || c.userId, by: c.imp.by, expires_at: r.expires_at, read_only: c.imp.readOnly };
}

/** True if `token` is a live, non-impersonated session of exactly `adminId`. */
export function isLiveAdminSession(token: string | undefined, adminId: string): boolean {
  const c = checkSession(token);
  return c.result !== "invalid" && !c.imp && c.userId === adminId;
}
