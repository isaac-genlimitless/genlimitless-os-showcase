import { NextResponse } from "next/server";
import { listRetired, restoreProposal } from "@/lib/proposal-restore";

// Recently retired proposals (read-only) and "put back". Restoring never sends anything.
export async function GET() {
  return NextResponse.json({ items: listRetired() });
}

export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  try {
    return NextResponse.json({ ok: true, ...restoreProposal({ kind: b.kind, id: Number(b.id), by: "owner" }) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
