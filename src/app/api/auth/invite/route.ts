import { NextRequest, NextResponse } from "next/server";
import {
  getAuthState, setPassword, createChallenge, challengeUser, completeChallenge,
  completeEnrollment, createSession, recordAuthEvent, tooManyFailures,
} from "@/lib/auth/store";
import { inviteUser, consumeInvite } from "@/lib/auth/invites";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/crypto";
import { issueLoginCode, verifyLoginCode } from "@/lib/auth/second-factor";
import {
  CHALLENGE_COOKIE, clientIp, setChallengeCookie, setSessionCookie, clearCookie,
} from "@/lib/auth/http";
import { ownsAccounts } from "@/lib/accounts/identity";

export const dynamic = "force-dynamic";

// The one-time setup link (/setup/<token>). Public path: the token IS the credential. It lets that member, and only
// them, choose a password and enroll the second factor, then signs them in. Every step re-checks the token, and the
// acting user is always the token's user (a body field can't name someone else). Owner cell only.
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!ownsAccounts()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  let body: { action?: string; token?: string; password?: string; code?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  const ip = clientIp(req);
  if (tooManyFailures(ip)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const user = inviteUser(token);
  if (!user) {
    recordAuthEvent("invite", false, ip);
    return NextResponse.json({ error: "invalid_link" }, { status: 404 });
  }
  const userId = user.id;

  if (body.action === "check") return NextResponse.json({ ok: true, name: user.display_name });

  if (body.action === "password") {
    const pw = typeof body.password === "string" ? body.password : "";
    if (pw.length < MIN_PASSWORD_LENGTH) return NextResponse.json({ error: "too_short" }, { status: 400 });
    setPassword(userId, pw);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "send_code") {
    if (!getAuthState(userId).hasPassword) return NextResponse.json({ error: "no_password" }, { status: 409 });
    const challengeId = createChallenge(userId, ip);
    const result = await issueLoginCode(userId, challengeId);
    const res = NextResponse.json(result.ok ? { ok: true } : { ok: false, reason: result.reason });
    setChallengeCookie(res, req, challengeId);
    return res;
  }

  if (body.action === "complete") {
    const challengeId = req.cookies.get(CHALLENGE_COOKIE)?.value || "";
    if (challengeUser(challengeId) !== userId) return NextResponse.json({ error: "no_challenge" }, { status: 401 });
    const code = typeof body.code === "string" ? body.code : "";
    if (!verifyLoginCode(userId, challengeId, code)) {
      recordAuthEvent("invite_code", false, ip, userId);
      return NextResponse.json({ error: "invalid" }, { status: 401 });
    }
    if (!consumeInvite(token)) return NextResponse.json({ error: "invalid_link" }, { status: 404 });
    completeChallenge(challengeId);
    const backupCodes = completeEnrollment(userId);
    const session = createSession(userId, { ip, userAgent: req.headers.get("user-agent") || "", method: "invite" });
    const res = NextResponse.json({ ok: true, backupCodes });
    setSessionCookie(res, req, session.token);
    clearCookie(res, CHALLENGE_COOKIE);
    return res;
  }

  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}
