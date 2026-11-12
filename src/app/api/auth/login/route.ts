import { NextRequest, NextResponse } from "next/server";
import {
  getAuthState, checkPassword, checkPasswordDummy, tooManyFailures, recordAuthEvent, createChallenge,
} from "@/lib/auth/store";
import { issueLoginCode } from "@/lib/auth/second-factor";
import { clientIp, setChallengeCookie } from "@/lib/auth/http";
import { findUserByLogin } from "@/lib/accounts/users";
import { currentUserId } from "@/lib/accounts/identity";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { password?: string; method?: string; username?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const ip = clientIp(req);
  // Username or email. Blank means this cell's own user, so the old single-field form keeps working for Owner.
  const named = typeof body.username === "string" && body.username.trim() !== "";
  // Only the blank form reveals "not set up" (this cell's own user); a named user never leaks whether it exists.
  if (!named && !getAuthState(currentUserId()).enrolled) return NextResponse.json({ error: "not_set_up" }, { status: 409 });
  const user = findUserByLogin(named ? body.username! : currentUserId());
  if (tooManyFailures(ip, user?.id)) return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });

  const pw = typeof body.password === "string" ? body.password : "";
  const state = user ? getAuthState(user.id) : null;
  // Same answer for "no such user" and "wrong password", and the same work done for both.
  if (!user || !state || !state.enrolled || !checkPassword(user.id, pw)) {
    if (!user || !state || !state.enrolled) checkPasswordDummy(pw);
    recordAuthEvent("password", false, ip, user?.id ?? null);
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }
  recordAuthEvent("password", true, ip, user.id);
  const challengeId = createChallenge(user.id, ip);

  let codeSent = false;
  let reason: string | undefined;
  if (body.method !== "totp" || !state.totpEnabled) {
    const result = await issueLoginCode(user.id, challengeId);
    if (result.ok) codeSent = true;
    else reason = result.reason;
  }
  const res = NextResponse.json({ ok: true, codeSent, totpAvailable: state.totpEnabled, reason });
  setChallengeCookie(res, req, challengeId);
  return res;
}
