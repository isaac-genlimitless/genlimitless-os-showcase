import { ownerName } from "@/lib/instance";
import { NextRequest, NextResponse } from "next/server";
import { CommentError, pageForComments, publicComment, setResolved } from "@/lib/file-comments";

export const dynamic = "force-dynamic";

// PATCH {resolved:boolean}. Behind the normal login + same-origin gate.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; cid: string }> }) {
  const p = await params;
  const r = pageForComments(Number(p.id));
  if (!r.page) return NextResponse.json({ error: r.error }, { status: r.status });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.resolved !== "boolean") return NextResponse.json({ error: "resolved (boolean) required" }, { status: 400 });
  try {
    const c = setResolved(r.page.id, Number(p.cid), body.resolved, ownerName());
    return NextResponse.json({ comment: publicComment(c) });
  } catch (e) {
    if (e instanceof CommentError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
