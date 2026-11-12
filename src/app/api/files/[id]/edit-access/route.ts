import { NextRequest, NextResponse } from "next/server";
import { getPage } from "@/lib/pages";
import {
  EditError,
  disableEdit,
  editActive,
  enableEdit,
  getAccess,
  lastEdit,
  listEdits,
  regenerateEdit,
  restoreEdit,
  setExpiry,
} from "@/lib/page-edit-access";

type Ctx = { params: Promise<{ id: string }> };

async function load(ctx: Ctx) {
  const id = Number((await ctx.params).id);
  const page = Number.isInteger(id) ? getPage(id) : undefined;
  return page;
}

// Owner only: behind normal login + same-origin. NOT in the public allowlist.
export async function GET(_req: NextRequest, ctx: Ctx) {
  const page = await load(ctx);
  if (!page) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (page.kind !== "page") return NextResponse.json({ error: "Only pages can be edited" }, { status: 400 });
  const a = getAccess(page.id);
  return NextResponse.json({
    enabled: !!a && a.enabled === 1,
    active: editActive(page, a),
    expires_at: a?.expires_at ?? null,
    shared: !!page.share_token,
    last_edit: lastEdit(page.id),
    edits: listEdits(page.id, 50),
  });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const page = await load(ctx);
  if (!page) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (page.kind !== "page") return NextResponse.json({ error: "Only pages can be edited" }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.action !== "string") return NextResponse.json({ error: "action required" }, { status: 400 });
  const expires = typeof body.expires_at === "string" && body.expires_at ? body.expires_at : null;
  try {
    switch (body.action) {
      case "enable": {
        const token = enableEdit(page.id, expires);
        return NextResponse.json({ token, path: `/edit/${token}` });
      }
      case "regenerate": {
        const token = regenerateEdit(page.id);
        return NextResponse.json({ token, path: `/edit/${token}` });
      }
      case "disable":
        disableEdit(page.id);
        return NextResponse.json({ enabled: false });
      case "set_expiry":
        setExpiry(page.id, expires);
        return NextResponse.json({ expires_at: getAccess(page.id)?.expires_at ?? null });
      case "restore": {
        const logId = Number(body.log_id);
        if (!Number.isInteger(logId)) return NextResponse.json({ error: "log_id required" }, { status: 400 });
        await restoreEdit(page.id, logId);
        return NextResponse.json({ restored: true });
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    const status = e instanceof EditError ? e.status : 400;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
