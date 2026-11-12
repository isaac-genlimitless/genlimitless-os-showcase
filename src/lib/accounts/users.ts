import accountsDb from "./db";
import { DEFAULT_USER } from "./identity";

export { DEFAULT_USER, currentUserId, mayRunOpenWhenUnenrolled } from "./identity";

export interface UserRow {
  id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  role: "owner" | "member";
  port: number | null;
  status: "active" | "disabled";
  created_at: number;
  removed_at?: number | null; // set by the admin soft-remove; NULL = not removed (column added by migrate.ts)
  updated_at?: number | null;
}

export function getUser(id: string): UserRow | undefined {
  return accountsDb.prepare(`SELECT * FROM users WHERE id = ?`).get(String(id).toLowerCase()) as UserRow | undefined;
}

/** Sign-in name: the slug or the email, case-insensitive. Only active users. */
export function findUserByLogin(identifier: string): UserRow | undefined {
  const k = String(identifier || "").trim().toLowerCase();
  if (!k) return undefined;
  return accountsDb
    .prepare(`SELECT * FROM users WHERE status = 'active' AND (id = ? OR lower(email) = ?) ORDER BY (id = ?) DESC LIMIT 1`)
    .get(k, k, k) as UserRow | undefined;
}

export function createUser(u: { id: string; display_name: string; email?: string | null; phone?: string | null; role?: "owner" | "member"; port?: number | null }): UserRow {
  const id = u.id.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) throw new Error("bad_user_id");
  accountsDb
    .prepare(`INSERT OR IGNORE INTO users (id, display_name, email, phone, role, port, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`)
    .run(id, u.display_name, u.email ?? null, u.phone ?? null, u.role ?? "member", u.port ?? null, Date.now());
  return getUser(id)!;
}

/** First run on a fresh accounts.db: the owner row for the legacy single user. Never touches an existing row. */
export function ensureDefaultOwner(): UserRow {
  return (
    getUser(DEFAULT_USER) ||
    createUser({ id: DEFAULT_USER, display_name: "Owner", phone: process.env.OWNER_IMESSAGE_HANDLE || null, role: "owner", port: 3100 })
  );
}
