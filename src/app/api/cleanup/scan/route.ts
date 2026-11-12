import { ownerOnly } from "@/lib/instance";
import { NextResponse } from "next/server";
import { runScan } from "@/lib/cleanup-scan";

export const dynamic = "force-dynamic";

// Run the (read-only) scan now and store a new pending report.
async function glosPOST() {
  const { id, items } = runScan();
  return NextResponse.json({ ok: true, reportId: id, count: items.length, items });
}

// Owner-only: 404 in a member cell (docs/multi-user.md "Member mode").
export const POST = ownerOnly(glosPOST);
