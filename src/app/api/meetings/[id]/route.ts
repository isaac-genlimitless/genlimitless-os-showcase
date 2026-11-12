import { NextRequest, NextResponse } from "next/server";
import { getMeeting, publicMeeting, renameMeeting, saveLiveTranscript } from "@/lib/meetings";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const m = getMeeting(Number((await params).id));
  if (!m) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ meeting: publicMeeting(m) });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const id = Number((await params).id);
  if (!getMeeting(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const input = await req.json();
  if (typeof input.live_transcript === "string") saveLiveTranscript(id, input.live_transcript);
  if (typeof input.title === "string") await renameMeeting(id, input.title);
  return NextResponse.json({ meeting: publicMeeting(getMeeting(id)!) });
}
