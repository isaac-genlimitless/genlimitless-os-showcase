import { ownerOnly } from "@/lib/instance";
import { NextRequest, NextResponse } from "next/server";
import { addAllowlistHandle, listAllowlist, removeAllowlistHandle } from "@/lib/text-drafts";

async function glosGET() {
  return NextResponse.json({ allowlist: listAllowlist() });
}

async function glosPOST(req: NextRequest) {
  const { handle, label } = await req.json();
  if (!handle) return NextResponse.json({ error: "handle is required" }, { status: 400 });
  return NextResponse.json({ allowlist: addAllowlistHandle(handle, label) });
}

async function glosDELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  return NextResponse.json({ allowlist: removeAllowlistHandle(id) });
}

// Owner-only: 404 in a member cell (docs/multi-user.md "Member mode").
export const GET = ownerOnly(glosGET);
export const POST = ownerOnly(glosPOST);
export const DELETE = ownerOnly(glosDELETE);
