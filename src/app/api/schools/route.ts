import { ownerOnly } from "@/lib/instance";
import { NextResponse } from "next/server";
import db from "@/lib/db";

export const dynamic = "force-dynamic";

// Health probe only. Schools are gone from the OS, but the deploy script installed on the server
// (/usr/local/bin/glos-deploy) still health-checks GET /api/schools and wants "schools" in the reply.
// Delete this file once that script has been updated to use /api/health (see bridge/glos-deploy).
async function glosGET() {
  try {
    db.prepare("SELECT 1").get();
    return NextResponse.json({ schools: [], deprecated: "health probe only; use /api/health" });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

// Owner-only: 404 in a member cell (docs/multi-user.md "Member mode").
export const GET = ownerOnly(glosGET);
