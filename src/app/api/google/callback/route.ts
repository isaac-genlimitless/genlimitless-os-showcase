import { NextRequest, NextResponse } from "next/server";
import { exchangeCode } from "@/lib/gdrive";
import { exchangeCode as exchangeGmailCode } from "@/lib/gmail";
import { exchangeCode as exchangeCalendarCode } from "@/lib/gcal";
import { upsertOAuthAccount } from "@/lib/mail-accounts";
import { logIssue } from "@/lib/db";

// One redirect URI (reused from gdrive.ts) serves every flow — the `state` param set by
// /api/google/auth tells them apart. No state (or anything else) means the original Drive flow.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  const state = req.nextUrl.searchParams.get("state") || "";
  const isGmail = state.startsWith("gmail:");
  const isCalendar = state === "calendar";

  if (!code)
    return NextResponse.redirect(
      new URL(`/analytics?${isGmail ? "gmail" : isCalendar ? "calendar" : "drive"}=${error || "cancelled"}`, req.url)
    );

  if (isGmail) {
    const label = decodeURIComponent(state.slice("gmail:".length));
    try {
      const { email, refreshToken, scope } = await exchangeGmailCode(code, req.nextUrl.origin);
      upsertOAuthAccount({ email, label: label || email, refreshToken, scopes: scope });
      return NextResponse.redirect(new URL("/analytics?gmail=connected", req.url));
    } catch (err: any) {
      logIssue("gmail_oauth", "Connecting a Gmail account failed", err.message);
      return NextResponse.redirect(new URL("/analytics?gmail=failed", req.url));
    }
  }

  if (isCalendar) {
    try {
      await exchangeCalendarCode(code, req.nextUrl.origin);
      return NextResponse.redirect(new URL("/analytics?calendar=connected", req.url));
    } catch (err: any) {
      logIssue("google_calendar", "Connecting Google Calendar failed", err.message);
      return NextResponse.redirect(new URL("/analytics?calendar=failed", req.url));
    }
  }

  try {
    await exchangeCode(code, req.nextUrl.origin);
    return NextResponse.redirect(new URL("/analytics?drive=connected", req.url));
  } catch (err: any) {
    logIssue("google_drive", "Connecting Google Drive failed", err.message);
    return NextResponse.redirect(new URL("/analytics?drive=failed", req.url));
  }
}
