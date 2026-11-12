import { NextRequest, NextResponse } from "next/server";
import {
  getAuthState, setPassword, createChallenge, challengeUser, completeChallenge,
  completeEnrollment, createSession, sessionUserId,
} from "@/lib/auth/store";
import { getUser, ensureDefaultOwner } from "@/lib/accounts/users";
import { currentUserId, DEFAULT_USER } from "@/lib/accounts/identity";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/crypto";
import { issueLoginCode, verifyLoginCode } from "@/lib/auth/second-factor";
import {
  CHALLENGE_COOKIE, SESSION_COOKIE, clientIp, setChallengeCookie, setSessionCookie, clearCookie,
} from "@/lib/auth/http";

export const dynamic = "force-dynamic";

// While not enrolled, nginx basic auth protects this endpoint. Once enrolled it refuses everything.
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { action?: string; password?: string; code?: string; user?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // Which account is being set up: the named user (must already exist in accounts.db), else this cell's own user.
  const userId = (typeof body.user === "string" && body.user.trim() ? body.user.trim() : currentUserId()).toLowerCase();
  if (userId === DEFAULT_USER) ensureDefaultOwner();
  if (!getUser(userId)) return NextResponse.json({ error: "unknown_user" }, { status: 404 });
  // A signed-in member may only set up their own account; only an owner may set up someone else.
  const who = sessionUserId(req.cookies.get(SESSION_COOKIE)?.value);
  if (who && who !== userId && getUser(who)?.role !== "owner") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const state = getAuthState(userId);
  if (state.enrolled) return NextResponse.json({ error: "already_enrolled" }, { status: 409 });

  if (body.action === "password") {
    const pw = typeof body.password === "string" ? body.password : "";
    if (pw.length < MIN_PASSWORD_LENGTH) return NextResponse.json({ error: "too_short" }, { status: 400 });
    setPassword(userId, pw);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "send_code") {
    if (!state.hasPassword) return NextResponse.json({ error: "no_password" }, { status: 409 });
    const challengeId = createChallenge(userId, clientIp(req));
    const result = await issueLoginCode(userId, challengeId);
    const res = NextResponse.json(result.ok ? { ok: true } : { ok: false, reason: result.reason });
    setChallengeCookie(res, req, challengeId);
    return res;
  }

  if (body.action === "complete") {
    const challengeId = req.cookies.get(CHALLENGE_COOKIE)?.value || "";
    if (challengeUser(challengeId) !== userId) return NextResponse.json({ error: "no_challenge" }, { status: 401 });
    const code = typeof body.code === "string" ? body.code : "";
    if (!verifyLoginCode(userId, challengeId, code)) return NextResponse.json({ error: "invalid" }, { status: 401 });
    completeChallenge(challengeId);
    const backupCodes = completeEnrollment(userId);
    const session = createSession(userId, {
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent") || "",
      method: "setup",
    });
    const res = NextResponse.json({ ok: true, backupCodes });
    setSessionCookie(res, req, session.token);
    clearCookie(res, CHALLENGE_COOKIE);
    return res;
  }

  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}
