import { NextRequest, NextResponse } from "next/server";
import { approveEmailDraft, createEmailDraft, discardEmailDraft, editEmailDraft, listEmailDrafts } from "@/lib/email-drafts";

// Owner's queue of agent-drafted emails to anyone (Communications → Email → Drafts).

export async function GET() {
  return NextResponse.json({ drafts: listEmailDrafts("pending_approval") });
}

// Seeds a draft directly (e2e tests, manual entry). Same function the agents' draft_email uses.
export async function POST(req: NextRequest) {
  const input = await req.json();
  try {
    return NextResponse.json(createEmailDraft({ ...input, created_by: input.created_by || "owner" }), { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

// { id, action: "approve" | "discard" | "edit", to?, subject?, body? }
export async function PATCH(req: NextRequest) {
  const { id, action, to, subject, body } = await req.json();
  if (!id || !action) return NextResponse.json({ error: "id and action are required" }, { status: 400 });
  try {
    if (action === "approve") return NextResponse.json(await approveEmailDraft(id, { to, subject, body }));
    if (action === "discard") return NextResponse.json(discardEmailDraft(id));
    if (action === "edit") return NextResponse.json(editEmailDraft(id, { to, subject, body }));
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
