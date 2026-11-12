import { ownerOnly } from "@/lib/instance";
import { NextResponse } from "next/server";
import { buildCodeMap } from "@/lib/code-map";

export const dynamic = "force-dynamic";

async function glosGET() {
  try {
    return NextResponse.json(buildCodeMap());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// Owner-only: 404 in a member cell (docs/multi-user.md "Member mode").
export const GET = ownerOnly(glosGET);
