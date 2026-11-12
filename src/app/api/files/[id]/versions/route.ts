import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { getPage, updatePage } from "@/lib/pages";
import { markdownToBlocks } from "@/lib/blocks";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const id = Number((await params).id);
  if (!getPage(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const versions = db
    .prepare(
      `SELECT id, page_id, title, substr(body, 1, 400) AS preview, length(body) AS length, source, agent_slug, created_at
       FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT 50`
    )
    .all(id);
  return NextResponse.json({ versions });
}

// Restore = write the chosen version back as the page's current content. The current state is
// snapshotted first (source 'undo'), so nothing is lost.
export async function POST(req: NextRequest, { params }: Ctx) {
  const id = Number((await params).id);
  if (!getPage(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const input = await req.json().catch(() => ({}));
  const v = db.prepare(`SELECT * FROM page_versions WHERE id = ? AND page_id = ?`).get(Number(input.version_id), id) as
    | { title: string | null; body: string | null; content: string | null }
    | undefined;
  if (!v) return NextResponse.json({ error: "version not found" }, { status: 404 });
  try {
    let blocks: unknown[] | null = null;
    if (v.content) {
      try {
        const parsed = JSON.parse(v.content);
        if (Array.isArray(parsed)) blocks = parsed;
      } catch {
        /* fall back to body */
      }
    }
    if (!blocks) blocks = await markdownToBlocks(v.body || "");
    const page = await updatePage(id, { content: blocks, title: v.title ?? undefined }, { source: "undo" });
    return NextResponse.json({ page: { ...page, content: undefined } });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
