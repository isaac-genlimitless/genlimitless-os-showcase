import { NextRequest, NextResponse } from "next/server";
import { DIRECTIONS, Direction, commitmentsOverview, listCommitments, recordCommitment, updateCommitment } from "@/lib/commitments";
import { refuseTestFixture } from "@/lib/data-dir";

// Owner's view of the commitments ledger (Today page). Closing is soft: status done/cancelled.

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const s = sp.get("status");
  const status = s === "open" || s === "done" || s === "cancelled" || s === "all" ? s : "open";
  const d = sp.get("direction");
  const direction = (DIRECTIONS as readonly string[]).includes(d || "") ? (d as Direction) : undefined;
  return NextResponse.json({ commitments: listCommitments({ status, direction, person: sp.get("person") || undefined }), overview: commitmentsOverview() });
}

export async function POST(req: NextRequest) {
  const input = await req.json().catch(() => null);
  if (!input || typeof input !== "object") return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  const refused = refuseTestFixture(input.what);
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  try {
    return NextResponse.json({ commitment: recordCommitment({ ...input, source: input.source || "manual" }, "owner") }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

// { id, status?, what?, person?, due_date?, close_note? }
export async function PATCH(req: NextRequest) {
  const { id, ...patch } = (await req.json().catch(() => ({}))) as { id?: number } & Record<string, any>;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    return NextResponse.json({ commitment: updateCommitment(Number(id), patch) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
