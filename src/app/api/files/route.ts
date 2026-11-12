import { NextRequest, NextResponse } from "next/server";
import { createPage, ensureFolderPath, listRecent, listTrash, listTree, searchPages, type PageKind } from "@/lib/pages";
import { saveFileToWorkspace } from "@/lib/file-upload";
import { scheduleOrganize } from "@/lib/organize";
import { refuseTestFixture } from "@/lib/data-dir";

// The Files workspace: the tree, search, the Trash, and creating pages/folders/uploads.

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = sp.get("q");
  if (q !== null) return NextResponse.json({ hits: searchPages(q, { limit: 30 }) });
  if (sp.get("trash")) return NextResponse.json({ trash: listTrash() });
  return NextResponse.json({ tree: listTree(), recent: listRecent(8) });
}

const KINDS: PageKind[] = ["page", "folder"];

export async function POST(req: NextRequest) {
  if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
    const form = await req.formData();
    const parent = Number(form.get("parent_id")) || null;
    const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) return NextResponse.json({ error: "no files" }, { status: 400 });
    const pages = [];
    for (const f of files) pages.push(await saveFileToWorkspace(f, parent));
    return NextResponse.json({ pages }, { status: 201 });
  }

  const input = await req.json();
  const refused = refuseTestFixture(input.title) || refuseTestFixture(input.folder_path);
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  const kind: PageKind = KINDS.includes(input.kind) ? input.kind : "page";
  try {
    const page = await createPage({
      title: typeof input.title === "string" && input.title.trim() ? input.title : kind === "folder" ? "New folder" : "Untitled",
      kind,
      parent_id: Number(input.parent_id) || (typeof input.folder_path === "string" && input.folder_path.trim() ? ensureFolderPath(input.folder_path, "owner") : null),
      body: typeof input.body === "string" ? input.body : undefined,
      content: Array.isArray(input.content) ? input.content : undefined,
      icon: input.icon ?? null,
      created_by: "owner",
    });
    if (page.kind !== "folder" && page.parent_id == null) scheduleOrganize(page.id);
    return NextResponse.json({ page: { ...page, content: undefined } }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
