import { NextRequest, NextResponse } from "next/server";
import { revokeSession } from "@/lib/auth/store";
import { stopImpersonation } from "@/lib/auth/impersonation";
import { SESSION_COOKIE, CHALLENGE_COOKIE, clearCookie } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    stopImpersonation(token); // audits and revokes if it is an impersonation session
    revokeSession(token);
  }
  const res = NextResponse.json({ ok: true });
  clearCookie(res, SESSION_COOKIE);
  clearCookie(res, CHALLENGE_COOKIE);
  res.cookies.set("glos_admin_return", "", { httpOnly: true, sameSite: "strict", path: "/api/auth/impersonate", maxAge: 0 });
  return res;
}
