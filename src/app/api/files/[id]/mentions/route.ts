import { NextRequest, NextResponse } from "next/server";
import { getPage } from "@/lib/pages";
import { listPageMentions, listIgnoredMentions, retryMention } from "@/lib/chief-mentions";

type Ctx = { params: Promise<{ id: string }> };

// The @Chief result boxes for one page (read by the editor; the boxes are never part of the page).
export async function GET(_req: NextRequest, { params }: Ctx) {
  const id = Number((await params).id);
  if (!getPage(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ mentions: listPageMentions(id), ignored: listIgnoredMentions(id), page_updated_at: getPage(id)!.updated_at });
}

// Owner pressed "Retry" on a box that errored: it goes back to waiting and runs on the next tick.
export async function POST(req: NextRequest, { params }: Ctx) {
  const id = Number((await params).id);
  if (!getPage(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const input = await req.json().catch(() => ({}));
  if (input?.action !== "retry" || !Number.isInteger(Number(input?.mention_id))) {
    return NextResponse.json({ error: "expected {mention_id, action:'retry'}" }, { status: 400 });
  }
  if (!retryMention(Number(input.mention_id), id)) {
    return NextResponse.json({ error: "that mention isn't in an error state" }, { status: 409 });
  }
  return NextResponse.json({ mentions: listPageMentions(id) });
}
