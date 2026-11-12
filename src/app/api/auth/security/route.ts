import { NextRequest, NextResponse } from "next/server";
import {
  getAuthState, unusedBackupCodeCount, listSessions, replaceBackupCodes, beginTotp, confirmTotp,
  disableTotp, revokeOtherSessions, setEnforce, sessionUserId,
} from "@/lib/auth/store";
import { SESSION_COOKIE, actingUser } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const uid = actingUser(req);
  if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const state = getAuthState(uid);
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return NextResponse.json({
    enrolled: state.enrolled,
    enforce: state.enforce,
    totpEnabled: state.totpEnabled,
    backupCodesLeft: unusedBackupCodeCount(uid),
    sessions: listSessions(uid, token),
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const uid = actingUser(req);
  if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { action?: string; code?: string; on?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!getAuthState(uid).enrolled) return NextResponse.json({ error: "not_enrolled" }, { status: 409 });
  const token = req.cookies.get(SESSION_COOKIE)?.value;

  switch (body.action) {
    case "regen_backup":
      return NextResponse.json({ backupCodes: replaceBackupCodes(uid) });
    case "totp_begin": {
      const t = beginTotp(uid);
      return NextResponse.json({ secret: t.secret, uri: t.uri });
    }
    case "totp_confirm": {
      const ok = confirmTotp(uid, typeof body.code === "string" ? body.code : "");
      if (!ok) return NextResponse.json({ error: "invalid" }, { status: 400 });
      return NextResponse.json({ ok: true });
    }
    case "totp_disable":
      disableTotp(uid);
      return NextResponse.json({ ok: true });
    case "revoke_others": {
      if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      return NextResponse.json({ ok: true, revoked: revokeOtherSessions(uid, token) });
    }
    case "set_enforce": {
      const on = body.on === true;
      if (on && sessionUserId(token) !== uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      setEnforce(uid, on);
      const revoked = on && token ? revokeOtherSessions(uid, token) : 0;
      return NextResponse.json({ ok: true, enforce: on, revoked });
    }
    default:
      return NextResponse.json({ error: "bad_action" }, { status: 400 });
  }
}
