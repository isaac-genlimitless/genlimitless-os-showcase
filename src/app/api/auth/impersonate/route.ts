import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, clientIp, secureCookie, setSessionCookie, clearCookie } from "@/lib/auth/http";
import {
  IMPERSONATION_TTL_MS, startImpersonation, stopImpersonation, impersonationStatus, isLiveAdminSession,
} from "@/lib/auth/impersonation";

export const dynamic = "force-dynamic";

// Always under /api/auth/, so nginx serves it from the owner cell.
export const RETURN_COOKIE = "glos_admin_return";
const RETURN_PATH = "/api/auth/impersonate";

function clearReturn(res: NextResponse): void {
  res.cookies.set(RETURN_COOKIE, "", { httpOnly: true, sameSite: "strict", path: RETURN_PATH, maxAge: 0 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { user_id?: unknown } = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const adminToken = req.cookies.get(SESSION_COOKIE)?.value;
  const r = startImpersonation(adminToken, String(body.user_id ?? ""), {
    ip: clientIp(req), userAgent: req.headers.get("user-agent") || "",
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.reason }, { status: r.status });
  const res = NextResponse.json({ ok: true, as: String(body.user_id), expires_at: r.expiresAt });
  setSessionCookie(res, req, r.token);
  res.cookies.set(SESSION_COOKIE, r.token, {
    httpOnly: true, sameSite: "lax", path: "/", secure: secureCookie(req), maxAge: Math.floor(IMPERSONATION_TTL_MS / 1000),
  });
  res.cookies.set(RETURN_COOKIE, adminToken as string, {
    httpOnly: true, sameSite: "strict", path: RETURN_PATH, secure: secureCookie(req), maxAge: Math.floor(IMPERSONATION_TTL_MS / 1000),
  });
  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return NextResponse.json(impersonationStatus(req.cookies.get(SESSION_COOKIE)?.value));
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const stopped = stopImpersonation(req.cookies.get(SESSION_COOKIE)?.value);
  const ret = req.cookies.get(RETURN_COOKIE)?.value;
  const res = NextResponse.json({ ok: true });
  if (stopped && ret && isLiveAdminSession(ret, stopped.by)) {
    setSessionCookie(res, req, ret);
  } else {
    clearCookie(res, SESSION_COOKIE);
  }
  clearReturn(res);
  return res;
}
