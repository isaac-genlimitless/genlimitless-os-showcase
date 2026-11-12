import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { revertSpellfixChange, restoreSpellfixVersion } from "@/lib/spellfix";

export async function GET() {
  const changes = db.prepare(`SELECT c.id, c.page_id, d.title, c.wrong, c.right, c.version_id, c.run_key, c.created_at, c.reverted_at FROM spellfix_changes c LEFT JOIN docs d ON d.id = c.page_id ORDER BY c.id DESC LIMIT 100`).all();
  return NextResponse.json({ changes });
}
export async function POST(req: NextRequest) {
  const { change_id, version_id } = await req.json();
  if (Number.isInteger(change_id)) return NextResponse.json(await revertSpellfixChange(change_id));
  if (Number.isInteger(version_id)) return NextResponse.json(restoreSpellfixVersion(version_id));
  return NextResponse.json({ error: "change_id or version_id required" }, { status: 400 });
}
