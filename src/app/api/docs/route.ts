import { NextRequest, NextResponse } from "next/server";
import { createDoc, listDocs } from "@/lib/docs";
import { refuseTestFixture } from "@/lib/data-dir";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") || undefined;
  return NextResponse.json({ docs: listDocs(q) });
}

export async function POST(req: NextRequest) {
  const input = await req.json();
  if (!input.title || typeof input.title !== "string") {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const refused = refuseTestFixture(input.title);
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  const doc = await createDoc(input);
  return NextResponse.json({ doc }, { status: 201 });
}
