import { NextRequest, NextResponse } from "next/server";
import { icloudTestConnection, isAppleConfigured } from "@/lib/icloud-caldav";

// There's no OAuth redirect flow for CalDAV (Apple only supports Basic auth with an
// app-specific password), so "connecting" Apple Calendar is just adding APPLE_ID /
// APPLE_APP_PASSWORD to .env.local. This route just confirms those are present and, on request,
// does a real PROPFIND round trip so Owner can see the connection actually works.
//
// GET ?status=1 → { configured } (no network call).
// GET ?test=1   → { ok, calendars } or { ok: false, error } from a live discovery pass.

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (sp.get("status")) {
    return NextResponse.json({ configured: isAppleConfigured() });
  }
  if (sp.get("test")) {
    if (!isAppleConfigured()) {
      return NextResponse.json({ ok: false, error: "APPLE_ID / APPLE_APP_PASSWORD aren't set in .env.local." }, { status: 409 });
    }
    try {
      const result = await icloudTestConnection();
      return NextResponse.json(result);
    } catch (err: any) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 502 });
    }
  }
  return NextResponse.json({ error: "pass ?status=1 or ?test=1" }, { status: 400 });
}
