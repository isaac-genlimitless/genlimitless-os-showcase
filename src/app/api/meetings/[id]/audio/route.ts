import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { appendAudio, audioFile, getMeeting } from "@/lib/meetings";

type Ctx = { params: Promise<{ id: string }> };

// POST: the recorder streams one chunk at a time (raw body), in order.
export async function POST(req: NextRequest, { params }: Ctx) {
  const id = Number((await params).id);
  try {
    appendAudio(id, Buffer.from(await req.arrayBuffer()));
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

// GET: play the recording back.
export async function GET(_req: NextRequest, { params }: Ctx) {
  const m = getMeeting(Number((await params).id));
  const file = m && audioFile(m);
  if (!m || !file || !fs.existsSync(file)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(fs.readFileSync(file), { headers: { "Content-Type": m.audio_mime || "audio/webm" } });
}
