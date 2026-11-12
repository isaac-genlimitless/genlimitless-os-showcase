import { NextRequest, NextResponse } from "next/server";
import { searchMentionables } from "@/lib/mentions";

// Read-only: the items Owner can tag with @ (pages/files, meetings, tasks).
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = sp.get("q") ?? "";
  const n = Number(sp.get("limit"));
  const limit = Number.isFinite(n) && n > 0 ? Math.min(20, Math.max(1, Math.floor(n))) : 12;
  return NextResponse.json({ items: searchMentionables(q, limit) });
}
