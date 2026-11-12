import { NextRequest, NextResponse } from "next/server";
import { disableShare, enableShare, getPage } from "@/lib/pages";

// POST {enabled:boolean}. Behind the normal login + same-origin gate.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const page = Number.isInteger(id) ? getPage(id) : undefined;
  if (!page) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled (boolean) required" }, { status: 400 });
  if (page.kind !== "page") return NextResponse.json({ error: "Only pages can be shared" }, { status: 400 });
  try {
    if (body.enabled) {
      const token = enableShare(id);
      return NextResponse.json({ shared: true, token, path: `/share/${token}` });
    }
    disableShare(id);
    return NextResponse.json({ shared: false, token: null, path: null });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
