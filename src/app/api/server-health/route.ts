import { ownerOnly } from "@/lib/instance";
import { NextResponse } from "next/server";
import { getServerHealth } from "@/lib/server-health";

export const dynamic = "force-dynamic";

async function glosGET() {
  try {
    return NextResponse.json(await getServerHealth());
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

// Owner-only: 404 in a member cell (docs/multi-user.md "Member mode").
export const GET = ownerOnly(glosGET);
