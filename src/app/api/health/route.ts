import { NextResponse } from "next/server";
import db from "@/lib/db";

export const dynamic = "force-dynamic";

// Deploy health probe (bridge/glos-deploy): the app is up and can read its database. Read-only.
export async function GET() {
  try {
    db.prepare("SELECT 1").get();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
