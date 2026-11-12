import db from "../accounts/db";
import { getUser, type UserRow } from "../accounts/users";
import { getAuthState } from "./store";
import { newToken, sha256Hex } from "./crypto";

// One-time setup links (/setup/<token>) for new members: let exactly that user set a password and enroll the second
// factor. Only the owner cell calls this (it is the only one that opens accounts.db). The token is shown once to the
// operator and only its hash is stored. A link never works for the owner, for an already-enrolled user, for a
// disabled user, after 72 hours, or twice.

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export function createInvite(userId: string, now: number = Date.now()): { token: string; expiresAt: number } {
  const u = getUser(userId);
  if (!u) throw new Error("unknown_user");
  if (u.role !== "member") throw new Error("owner_has_no_invite");
  if (getAuthState(u.id).enrolled) throw new Error("already_enrolled");
  // A newer link replaces older unused ones.
  db.prepare(`UPDATE auth_invites SET used_at = ? WHERE user_id = ? AND used_at IS NULL`).run(now, u.id);
  const token = newToken();
  const expiresAt = now + INVITE_TTL_MS;
  db.prepare(`INSERT INTO auth_invites (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(u.id, sha256Hex(token), now, expiresAt);
  return { token, expiresAt };
}

/** The member a token belongs to, or null when it is unknown, expired, used, or its user may not use a link. */
export function inviteUser(token: string, now: number = Date.now()): UserRow | null {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const r = db.prepare(`SELECT user_id FROM auth_invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`).get(sha256Hex(token), now) as { user_id: string } | undefined;
  if (!r) return null;
  const u = getUser(r.user_id);
  if (!u || u.status !== "active" || u.role !== "member") return null;
  if (getAuthState(u.id).enrolled) return null;
  return u;
}

/** Marks the link used. False if it was already used (or invalid): only one caller can win. */
export function consumeInvite(token: string, now: number = Date.now()): boolean {
  return db.prepare(`UPDATE auth_invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`).run(now, sha256Hex(token), now).changes > 0;
}
