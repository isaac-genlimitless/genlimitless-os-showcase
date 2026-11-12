import { NextRequest, NextResponse } from "next/server";
import { createThread, listOpenThreads, mergeThread } from "@/lib/chat-threads";

export async function GET() {
  return NextResponse.json({ threads: listOpenThreads() });
}

// Open a new side chat.
export async function POST(req: NextRequest) {
  const { title } = await req.json().catch(() => ({}));
  return NextResponse.json({ thread: createThread(title) }, { status: 201 });
}

// Close a side chat: its transcript is merged into the main feed (nothing is deleted).
export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    return NextResponse.json(mergeThread(id));
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
