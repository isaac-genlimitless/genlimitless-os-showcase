import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { decide, toHeaderMap, isDeployProbe, isLoopback, INTERNAL_HEADER, FINGERPRINT_HEADER, tokenFingerprint } from "@/lib/auth/policy";
import { getAuthState, checkSession } from "@/lib/auth/store";
import { internalSecret } from "@/lib/auth/crypto";
import { askOwner } from "@/lib/auth/owner-check";
import { SESSION_COOKIE, setSessionCookie } from "@/lib/auth/http";
import { currentUserId, mayRunOpenWhenUnenrolled, ownsAccounts } from "@/lib/accounts/identity";
import { DATA_DIR } from "@/lib/data-dir";

function breakGlass(): boolean {
  return process.env.AUTH_BREAK_GLASS === "1" || fs.existsSync(path.join(DATA_DIR, "AUTH_DISABLED"));
}

// The sign-in and security surface. nginx always sends it to the owner cell, which serves EVERY user's sessions here
// (it acts on the session's user, not on GLOS_USER). It is the only place the wrong-cell guard is relaxed.
function isAuthSurface(p: string): boolean {
  return p.startsWith("/api/auth/") || p === "/security" || p.startsWith("/security/");
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const pathname = req.nextUrl.pathname;
  internalSecret(); // this cell's own loopback secret: created on first request, then cached
  if (isDeployProbe(process.env, req.method, pathname)) return NextResponse.next();
  // Every cell belongs to one user (GLOS_USER, default owner). A valid session of anyone else is not valid here,
  // even if the reverse proxy routed it to this port by mistake.
  const me = currentUserId();
  const owner = ownsAccounts();
  const token = req.cookies.get(SESSION_COOKIE)?.value;

  let enrolled = true;
  let enforce = true;
  let sessionValid = false;
  let slid = false;
  let imp: "ro" | "rw" | undefined;
  let by: string | undefined;
  if (owner) {
    const state = getAuthState(me);
    // The legacy single-user setup stays open until its user enrolls; every other cell always demands a session.
    enrolled = mayRunOpenWhenUnenrolled() ? state.enrolled : true;
    enforce = mayRunOpenWhenUnenrolled() ? state.enforce : true;
    const check = enrolled && enforce ? checkSession(token) : ({ result: "invalid" } as const);
    sessionValid = check.result !== "invalid" && (check.userId === me || isAuthSurface(pathname));
    slid = check.result === "slid" && check.userId === me;
    if (sessionValid && check.result !== "invalid") {
      const ic = check as { imp?: "ro" | "rw"; by?: string };
      imp = ic.imp;
      by = ic.by;
    }
  } else {
    // Member cell: never opens accounts.db. It has no auth endpoints of its own (nginx sends them to the owner),
    // and asks the owner over loopback whether the cookie belongs to this cell's user. Fail closed.
    if (pathname.startsWith("/api/auth/")) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (token) {
      const answer = await askOwner(token, me);
      sessionValid = answer.ok;
      slid = answer.slid;
      if (answer.ok) {
        imp = answer.imp;
        by = answer.by;
      }
    }
  }

  // Viewing as another user is read-only: no write method gets through, except leaving the view / logging out.
  const readMethod = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
  const exempt =
    (req.method === "DELETE" && pathname === "/api/auth/impersonate") ||
    (req.method === "POST" && pathname === "/api/auth/logout");
  if (sessionValid && imp === "ro" && !readMethod && !exempt) {
    return NextResponse.json({ error: "impersonation_read_only" }, { status: 403 });
  }

  const d = decide({
    path: pathname, method: req.method, headers: toHeaderMap(req.headers),
    enrolled, enforce, breakGlass: breakGlass(),
    sessionValid,
  });
  if (d === "allow") {
    // Never trust a client-sent attribution header; forward the real admin slug only for impersonation sessions.
    const fwd = new Headers(req.headers);
    fwd.delete("x-glos-impersonator");
    if (sessionValid && imp && by) fwd.set("x-glos-impersonator", by);
    const res = NextResponse.next({ request: { headers: fwd } });
    if (slid && sessionValid && token) setSessionCookie(res, req, token);
    return res;
  }
  const hdrs = toHeaderMap(req.headers);
  const fpHeaders: Record<string, string> = isLoopback(hdrs) && hdrs[INTERNAL_HEADER] ? { [FINGERPRINT_HEADER]: tokenFingerprint() } : {};
  if (d === "unauthorized") return NextResponse.json({ error: "login_required" }, { status: 401, headers: fpHeaders });
  if (d === "forbidden") return NextResponse.json({ error: "cross_site_request" }, { status: 403, headers: fpHeaders });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static/).*)"] };
