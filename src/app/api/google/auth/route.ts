import { NextRequest, NextResponse } from "next/server";
import { authUrl, isDriveConnected } from "@/lib/gdrive";
import { authUrl as gmailAuthUrl } from "@/lib/gmail";
import { authUrl as calendarAuthUrl, isCalendarConnected } from "@/lib/gcal";

// GET ?status=1                  → { connected } for Google Drive (unchanged).
// GET ?status=1&service=calendar → { connected } for Google Calendar.
// GET                            → redirect to Google's consent screen for Drive.
// GET ?service=gmail&label=…     → redirect to the Gmail consent screen; the state param carries
//                                   the label through so /api/google/callback can tell flows apart.
// GET ?service=calendar          → redirect to the Calendar consent screen.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (sp.get("status")) {
    if (sp.get("service") === "calendar")
      return NextResponse.json({ connected: await isCalendarConnected(), configured: !!process.env.GOOGLE_CLIENT_ID });
    return NextResponse.json({ connected: isDriveConnected(), configured: !!process.env.GOOGLE_CLIENT_ID });
  }

  try {
    if (sp.get("service") === "gmail") {
      const label = (sp.get("label") || "").trim().slice(0, 60);
      const state = `gmail:${encodeURIComponent(label)}`;
      return NextResponse.redirect(gmailAuthUrl(req.nextUrl.origin, state));
    }
    if (sp.get("service") === "calendar") return NextResponse.redirect(calendarAuthUrl(req.nextUrl.origin));
    return NextResponse.redirect(authUrl(req.nextUrl.origin));
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
