import { ownerOnly } from "@/lib/instance";
import { NextResponse } from "next/server";
import { bridgeStatus } from "@/lib/bridge-health";

export const dynamic = "force-dynamic";

async function glosGET() {
  return NextResponse.json(bridgeStatus());
}

// Owner-only: 404 in a member cell (docs/multi-user.md "Member mode").
export const GET = ownerOnly(glosGET);
