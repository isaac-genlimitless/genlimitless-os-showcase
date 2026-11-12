import accountsDb from "./db";
import { getUser } from "./users";
import type { UserRow } from "./users";
import { revokeAllSessions } from "../auth/store";

// Admin = role 'owner' (the only admin role that exists). Every function takes the acting user's id and refuses
// anyone who is not an active, non-removed owner. Every mutation writes one admin_audit row. Removal is SOFT:
// status='disabled' + removed_at; the row, credentials and data folder stay, and restoreUser brings the user back.

export type AdminUser = {
  id: string; display_name: string; email: string | null; phone: string | null;
  role: "owner" | "member"; roleLabel: "Admin" | "Member"; status: "active" | "disabled";
  created_at: number; last_active: number | null; removed_at: number | null;
};
export type AuditRow = { id: number; at: number; actor: string; action: string; target: string | null; detail: string | null; ip: string | null };

type DbUserRow = {
  id: string; display_name: string; email: string | null; phone: string | null;
  role: "owner" | "member"; status: "active" | "disabled"; created_at: number;
  removed_at: number | null; last_active: number | null;
};

export function requireAdmin(actor: string): UserRow {
  const u = getUser(String(actor || ""));
  if (!u || u.status !== "active" || u.removed_at || u.role !== "owner") throw new Error("forbidden");
  return u;
}

export function recordAdminAudit(actor: string, action: string, target: string | null, detail?: unknown, ip?: string | null): void {
  accountsDb
    .prepare(`INSERT INTO admin_audit (at, actor, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(Date.now(), actor, action, target, detail === undefined ? null : JSON.stringify(detail), ip ?? null);
}

// Explicit columns only. Never touches auth_credentials, token hashes, TOTP or backup codes.
const SELECT_USERS = `SELECT u.id, u.display_name, u.email, u.phone, u.role, u.status, u.created_at, u.removed_at,
  (SELECT MAX(s.last_seen_at) FROM auth_sessions s WHERE s.user_id = u.id AND s.impersonator_id IS NULL) AS last_active
  FROM users u`;

function toAdminUser(r: DbUserRow): AdminUser {
  return {
    id: r.id, display_name: r.display_name, email: r.email, phone: r.phone, role: r.role,
    roleLabel: r.role === "owner" ? "Admin" : "Member", status: r.status, created_at: r.created_at,
    last_active: r.last_active ?? null, removed_at: r.removed_at ?? null,
  };
}

function view(id: string): AdminUser {
  const r = accountsDb.prepare(`${SELECT_USERS} WHERE u.id = ?`).get(id) as DbUserRow | undefined;
  if (!r) throw new Error("not_found");
  return toAdminUser(r);
}

export function listUsers(actor: string, opts: { includeRemoved?: boolean } = {}): AdminUser[] {
  requireAdmin(actor);
  const rows = accountsDb
    .prepare(`${SELECT_USERS} WHERE (? = 1 OR u.removed_at IS NULL) ORDER BY u.created_at ASC`)
    .all(opts.includeRemoved ? 1 : 0) as DbUserRow[];
  return rows.map(toAdminUser);
}

function target(id: string): UserRow {
  const t = getUser(String(id || ""));
  if (!t) throw new Error("not_found");
  return t;
}

function activeAdminCountExcluding(id: string): number {
  return (accountsDb.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND status = 'active' AND removed_at IS NULL AND id != ?`).get(id) as { n: number }).n;
}

export function updateUser(actor: string, id: string, patch: { display_name?: string; email?: string | null; phone?: string | null }, ip?: string | null): AdminUser {
  requireAdmin(actor);
  const t = target(id);
  if (t.removed_at) throw new Error("removed");
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (patch.display_name !== undefined) {
    const n = String(patch.display_name).trim();
    if (!n || n.length > 80) throw new Error("bad_name");
    sets.push("display_name = ?"); vals.push(n);
  }
  if (patch.email !== undefined) {
    const e = patch.email === null ? "" : String(patch.email).trim().toLowerCase();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error("bad_email");
    if (e && accountsDb.prepare(`SELECT id FROM users WHERE lower(email) = ? AND id != ?`).get(e, t.id)) throw new Error("email_taken");
    sets.push("email = ?"); vals.push(e || null);
  }
  if (patch.phone !== undefined) {
    const p = patch.phone === null ? "" : String(patch.phone).trim();
    if (p && !/^\+?[0-9][0-9 ()\-.]{5,19}$/.test(p)) throw new Error("bad_phone");
    sets.push("phone = ?"); vals.push(p || null);
  }
  if (!sets.length) return view(t.id);
  accountsDb.transaction(() => {
    accountsDb.prepare(`UPDATE users SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), t.id);
    recordAdminAudit(actor, "user.update", t.id, { fields: Object.keys(patch) }, ip);
  })();
  return view(t.id);
}

export function changeRole(actor: string, id: string, role: "owner" | "member", ip?: string | null): AdminUser {
  const a = requireAdmin(actor);
  if (role !== "owner" && role !== "member") throw new Error("bad_role");
  const t = target(id);
  if (t.id === a.id) throw new Error("self_change");
  if (t.removed_at) throw new Error("removed");
  if (t.role === role) return view(t.id);
  if (t.role === "owner" && role === "member" && t.status === "active" && activeAdminCountExcluding(t.id) < 1) throw new Error("last_admin");
  accountsDb.transaction(() => {
    accountsDb.prepare(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`).run(role, Date.now(), t.id);
    recordAdminAudit(actor, "user.role", t.id, { from: t.role, to: role }, ip);
  })();
  return view(t.id);
}

export function setStatus(actor: string, id: string, status: "active" | "disabled", ip?: string | null): AdminUser {
  const a = requireAdmin(actor);
  if (status !== "active" && status !== "disabled") throw new Error("bad_status");
  const t = target(id);
  if (t.id === a.id) throw new Error("self_change");
  if (t.removed_at) throw new Error("removed"); // call restoreUser first
  if (status === "disabled" && t.role === "owner" && t.status === "active" && activeAdminCountExcluding(t.id) < 1) throw new Error("last_admin");
  if (t.status === status) return view(t.id);
  accountsDb.transaction(() => {
    accountsDb.prepare(`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), t.id);
    if (status === "disabled") revokeAllSessions(t.id);
    recordAdminAudit(actor, status === "disabled" ? "user.deactivate" : "user.reactivate", t.id, undefined, ip);
  })();
  return view(t.id);
}

export function removeUser(actor: string, id: string, ip?: string | null): AdminUser {
  const a = requireAdmin(actor);
  const t = target(id);
  if (t.id === a.id) throw new Error("self_change");
  if (t.role === "owner") throw new Error("cannot_remove_admin");
  if (t.removed_at) return view(t.id);
  accountsDb.transaction(() => {
    const now = Date.now();
    accountsDb.prepare(`UPDATE users SET status = 'disabled', removed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, t.id);
    revokeAllSessions(t.id);
    recordAdminAudit(actor, "user.remove", t.id, { soft: true }, ip);
  })();
  return view(t.id);
}

export function restoreUser(actor: string, id: string, ip?: string | null): AdminUser {
  requireAdmin(actor);
  const t = target(id);
  if (!t.removed_at) throw new Error("not_removed");
  accountsDb.transaction(() => {
    accountsDb.prepare(`UPDATE users SET removed_at = NULL, status = 'active', updated_at = ? WHERE id = ?`).run(Date.now(), t.id);
    recordAdminAudit(actor, "user.restore", t.id, undefined, ip);
  })();
  return view(t.id);
}

export function listAudit(actor: string, limit = 200): AuditRow[] {
  requireAdmin(actor);
  const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
  return accountsDb.prepare(`SELECT id, at, actor, action, target, detail, ip FROM admin_audit ORDER BY id DESC LIMIT ?`).all(n) as AuditRow[];
}
