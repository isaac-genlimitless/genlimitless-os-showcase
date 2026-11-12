import { NextRequest, NextResponse } from "next/server";
import { getAuthState, sessionUserId } from "./store";
import { currentUserId, mayRunOpenWhenUnenrolled } from "../accounts/identity";

export const SESSION_COOKIE = "glos_session";
export const CHALLENGE_COOKIE = "glos_challenge";

export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return "local";
}

export function secureCookie(req: NextRequest): boolean {
  return req.headers.get("x-forwarded-proto") === "https";
}

export function setSessionCookie(res: NextResponse, req: NextRequest, token: string): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: secureCookie(req),
    maxAge: 30 * 24 * 60 * 60,
  });
}

export function setChallengeCookie(res: NextResponse, req: NextRequest, token: string): void {
  res.cookies.set(CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: secureCookie(req),
    maxAge: 600,
  });
}

export function clearCookie(res: NextResponse, name: string): void {
  res.cookies.set(name, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

/** The user a request acts as: the signed-in user, or (legacy single-user setup only, before enrolling) this cell's own user.
 *  null means "not allowed". */
export function actingUser(req: NextRequest): string | null {
  const uid = sessionUserId(req.cookies.get(SESSION_COOKIE)?.value);
  if (uid) return uid;
  const me = currentUserId();
  if (mayRunOpenWhenUnenrolled() && !getAuthState(me).enrolled) return me;
  return null;
}
