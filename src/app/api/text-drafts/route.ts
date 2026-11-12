import { ownerOnly } from "@/lib/instance";
import { NextRequest, NextResponse } from "next/server";
import { approveTextDraft, createTextDraft, editTextDraft, getTextDraft, listTextDrafts, rejectTextDraft } from "@/lib/text-drafts";

// ?id=<n> returns one draft (the chat's review card); no id = all of them.
async function glosGET(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (id) {
    const draft = getTextDraft(id);
    return draft ? NextResponse.json({ draft }) : NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ drafts: listTextDrafts() });
}

async function glosPOST(req: NextRequest) {
  const { to, chat_guid, text, reason, suggested_send_at } = await req.json();
  try {
    const result = await createTextDraft({ to, chat_guid, text, reason, suggested_send_at });
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

async function glosPATCH(req: NextRequest) {
  const { draft_id, action, edited_text, suggested_send_at } = await req.json();
  if (!draft_id || !action) {
    return NextResponse.json({ error: "draft_id and action are required" }, { status: 400 });
  }
  try {
    if (action === "approve") return NextResponse.json(await approveTextDraft(draft_id, edited_text));
    if (action === "reject") return NextResponse.json(rejectTextDraft(draft_id));
    if (action === "edit")
      return NextResponse.json(editTextDraft(draft_id, { text: edited_text, suggested_send_at }));
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Owner-only: 404 in a member cell (docs/multi-user.md "Member mode").
export const GET = ownerOnly(glosGET);
export const POST = ownerOnly(glosPOST);
export const PATCH = ownerOnly(glosPATCH);
