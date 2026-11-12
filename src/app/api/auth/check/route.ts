import { NextRequest, NextResponse } from "next/server";
import { checkSession } from "@/lib/auth/store";
import { SESSION_COOKIE } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

// Used by nginx auth_request AND by member cells' proxy (over loopback, forwarding only the cookie).
// 204 only for a real, unexpired, unrevoked session of an active user; 401 for everything else (never depends on
// enforce/enrolled/break-glass). X-Glos-User names the session's owner: nginx routes on it, member cells compare it.
// This is where the sliding expiry is refreshed (X-Glos-Slid tells the caller to refresh the cookie too).
export async function GET(req: NextRequest): Promise<NextResponse> {
  const c = checkSession(req.cookies.get(SESSION_COOKIE)?.value);
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (c.result !== "invalid") {
    headers["X-Glos-User"] = c.userId;
    if (c.result === "slid") headers["X-Glos-Slid"] = "1";
    // Part 3 adds imp/by to the session check when an admin is viewing as this user. Normal sessions send neither.
    const ic = c as { imp?: "ro" | "rw"; by?: string };
    if (ic.imp === "ro" || ic.imp === "rw") {
      headers["X-Glos-Imp"] = ic.imp;
      if (ic.by) headers["X-Glos-Impersonator"] = ic.by;
    }
  }
  return new NextResponse(null, { status: c.result !== "invalid" ? 204 : 401, headers });
}
