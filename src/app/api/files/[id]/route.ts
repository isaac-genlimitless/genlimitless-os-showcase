import { NextRequest, NextResponse } from "next/server";
import {
  archivePage,
  breadcrumb,
  currentBlocks,
  deletePageForever,
  getPage,
  listChildren,
  movePage,
  PageConflictError,
  pageTags,
  restorePage,
  updatePage,
} from "@/lib/pages";
import { scheduleOrganize } from "@/lib/organize";
import { getMeetingForPage } from "@/lib/meetings";

type Ctx = { params: Promise<{ id: string }> };

async function view(id: number) {
  const page = getPage(id)!;
  return {
    page: { ...page, tags: pageTags(page), content: undefined },
    blocks: page.kind === "folder" || page.kind === "file" ? [] : await currentBlocks(page),
    breadcrumb: breadcrumb(id),
    children: listChildren(id).map((c) => ({ ...c, tags: pageTags(c) })),
    meeting: page.kind === "meeting" ? getMeetingForPage(id) : null,
  };
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  const id = Number((await params).id);
  if (!getPage(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(await view(id));
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const id = Number((await params).id);
  if (!getPage(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const input = await req.json();
  try {
    if (input.restore) restorePage(id);
    if ("parent_id" in input) movePage(id, input.parent_id ? Number(input.parent_id) : null, "owner", input.before_id ?? null);
    const page = await updatePage(
      id,
      {
        title: typeof input.title === "string" ? input.title : undefined,
        content: Array.isArray(input.content) ? input.content : undefined,
        icon: "icon" in input ? input.icon || null : undefined,
        tags: Array.isArray(input.tags) ? input.tags.map(String) : undefined,
        favorite: typeof input.favorite === "boolean" ? input.favorite : undefined,
        link: typeof input.link === "string" || input.link === null ? input.link : undefined,
      },
      { source: "ui", base_updated_at: typeof input.base_updated_at === "string" ? input.base_updated_at : null }
    );
    if (input.content !== undefined || input.title !== undefined) scheduleOrganize(id);
    return NextResponse.json({ page: { ...page, tags: pageTags(page), content: undefined } });
  } catch (err: any) {
    if (err instanceof PageConflictError) {
      return NextResponse.json({ error: "page changed", updated_at: getPage(id)?.updated_at }, { status: 409 });
    }
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

// Default: move to the Trash (restorable). ?forever=1 permanently deletes ONE item that's
// already in the Trash — only reachable from Owner's own "Delete forever" button.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const id = Number((await params).id);
  if (!getPage(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    if (req.nextUrl.searchParams.get("forever")) return NextResponse.json(deletePageForever(id));
    return NextResponse.json(archivePage(id));
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
