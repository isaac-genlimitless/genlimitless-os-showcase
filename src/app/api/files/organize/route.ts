import { NextRequest, NextResponse } from "next/server";
import { organizePage, organizeUnfiled } from "@/lib/organize";

// { id }: file/label one item now. {}: "Tidy up" every unfiled item at the top level.
export async function POST(req: NextRequest) {
  const input = await req.json().catch(() => ({}));
  try {
    if (input.id) return NextResponse.json({ result: await organizePage(Number(input.id), { force: true }) });
    return NextResponse.json({ filed: await organizeUnfiled() });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
