import { NextRequest, NextResponse } from "next/server";
import {
  tooManyFailures, challengeUser, completeChallenge, consumeBackupCode, checkTotp,
  createSession, recordAuthEvent, unusedBackupCodeCount,
} from "@/lib/auth/store";
import { verifyLoginCode } from "@/lib/auth/second-factor";
import {
  CHALLENGE_COOKIE, clientIp, setSessionCookie, clearCookie,
} from "@/lib/auth/http";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { code?: string; kind?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const ip = clientIp(req);
  const challengeId = req.cookies.get(CHALLENGE_COOKIE)?.value || "";
  const userId = challengeUser(challengeId);
  if (tooManyFailures(ip, userId)) return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
  if (!userId) return NextResponse.json({ error: "no_challenge" }, { status: 401 });

  const kind = body.kind;
  const code = typeof body.code === "string" ? body.code : "";
  let ok = false;
  if (kind === "imessage") ok = verifyLoginCode(userId, challengeId, code);
  else if (kind === "backup") ok = consumeBackupCode(userId, code);
  else if (kind === "totp") ok = checkTotp(userId, code);
  else return NextResponse.json({ error: "bad_kind" }, { status: 400 });

  if (!ok) {
    recordAuthEvent(kind, false, ip, userId);
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }
  completeChallenge(challengeId);
  const session = createSession(userId, { ip, userAgent: req.headers.get("user-agent") || "", method: kind });
  recordAuthEvent(kind, true, ip, userId);
  const res = NextResponse.json({ ok: true, backupCodesLeft: unusedBackupCodeCount(userId) });
  setSessionCookie(res, req, session.token);
  clearCookie(res, CHALLENGE_COOKIE);
  return res;
}
