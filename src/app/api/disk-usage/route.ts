import { ownerOnly } from "@/lib/instance";
import { NextResponse } from "next/server";
import { getDiskUsage } from "@/lib/disk-usage";

export const dynamic = "force-dynamic";

async function glosGET(req: Request) {
  try {
    const fresh = new URL(req.url).searchParams.get("fresh") === "1";
    return NextResponse.json(await getDiskUsage({ fresh }));
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

// Owner-only: 404 in a member cell (docs/multi-user.md "Member mode").
export const GET = ownerOnly(glosGET);
