import { NextRequest, NextResponse } from "next/server";
import { finishMeeting, getMeeting, publicMeeting } from "@/lib/meetings";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!getMeeting(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const input = await req.json().catch(() => ({}));
  const m = finishMeeting(id, typeof input.live_transcript === "string" ? input.live_transcript : undefined);
  return NextResponse.json({ meeting: publicMeeting(m) });
}
