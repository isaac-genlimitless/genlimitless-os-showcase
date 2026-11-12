import { NextRequest, NextResponse } from "next/server";
import accountsDb from "./db";
import { requireAdmin } from "./admin";
import { sessionUserId } from "../auth/store";
import { SESSION_COOKIE, clientIp } from "../auth/http";
import { sha256Hex } from "../auth/crypto";

export type AdminCtx = { actor: string; ip: string };

/** True for a time-limited "view as" session (part 3 sets impersonator_id / read_only; columns exist since migrate.ts). */
export function isViewAsSession(token: string): boolean {
  const r = accountsDb
    .prepare(`SELECT impersonator_id, read_only FROM auth_sessions WHERE token_hash = ?`)
    .get(sha256Hex(token)) as { impersonator_id: string | null; read_only: number | null } | undefined;
  return !!r && (r.impersonator_id != null || Boolean(r.read_only));
}

/** The real signed-in admin, or the error response to return. */
export function adminContext(req: NextRequest): AdminCtx | NextResponse {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const actor = token ? sessionUserId(token) : null;
  if (!token || !actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (isViewAsSession(token)) return NextResponse.json({ error: "impersonation_read_only" }, { status: 403 });
  try {
    requireAdmin(actor);
  } catch {
    return NextResponse.json({ error: "admin_only" }, { status: 403 });
  }
  return { actor, ip: clientIp(req) };
}

const CONFLICT = new Set(["self_change", "last_admin", "cannot_remove_admin", "removed", "not_removed", "email_taken"]);
const INVALID = new Set(["bad_name", "bad_email", "bad_phone", "bad_role", "bad_status", "bad_user_id"]);

/** Library errors -> status. Unknown errors are not leaked. */
export function adminError(e: unknown): NextResponse {
  const m = e instanceof Error ? e.message : "";
  if (m === "not_found") return NextResponse.json({ error: m }, { status: 404 });
  if (m === "forbidden") return NextResponse.json({ error: "admin_only" }, { status: 403 });
  if (CONFLICT.has(m)) return NextResponse.json({ error: m }, { status: 409 });
  if (INVALID.has(m)) return NextResponse.json({ error: m }, { status: 400 });
  return NextResponse.json({ error: "server_error" }, { status: 500 });
}
