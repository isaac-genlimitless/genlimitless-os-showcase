import { ownerOnly } from "@/lib/instance";
import { NextResponse } from "next/server";
import { latestPending } from "@/lib/cleanup-scan";

export const dynamic = "force-dynamic";

// Latest pending cleanup report (or null). Read-only.
async function glosGET() {
  return NextResponse.json({ report: latestPending() });
}

// Owner-only: 404 in a member cell (docs/multi-user.md "Member mode").
export const GET = ownerOnly(glosGET);
