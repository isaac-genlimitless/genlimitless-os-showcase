import { ownerName } from "@/lib/instance";
import { NextRequest, NextResponse } from "next/server";
import { addComment, CommentError, listComments, pageForComments, publicComment } from "@/lib/file-comments";

export const dynamic = "force-dynamic";

// Owner API, behind the normal login + same-origin gate.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = pageForComments(Number((await params).id));
  if (!r.page) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ comments: listComments(r.page.id).map(publicComment) });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = pageForComments(Number((await params).id));
  if (!r.page) return NextResponse.json({ error: r.error }, { status: r.status });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  try {
    const c = addComment(r.page, body, ownerName(), "owner");
    return NextResponse.json({ comment: publicComment(c) });
  } catch (e) {
    if (e instanceof CommentError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
