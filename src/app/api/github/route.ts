import { ownerOnly } from "@/lib/instance";
import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { closePR, getPR, mergePR } from "@/lib/github";

// GET ?pr=N → live PR details for the chat card
async function glosGET(req: NextRequest) {
  const n = Number(req.nextUrl.searchParams.get("pr"));
  if (!n) return NextResponse.json({ error: "pr is required" }, { status: 400 });
  try {
    return NextResponse.json(await getPR(n));
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST { action: "merge" | "close", number }
async function glosPOST(req: NextRequest) {
  const { action, number } = await req.json();
  try {
    if (action === "merge") {
      const r = await mergePR(number);
      db.prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant', ?)`).run(r.message);
      return NextResponse.json(r);
    }
    if (action === "close") {
      await closePR(number);
      db.prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant', ?)`).run(`Closed pull request #${number} without merging.`);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Owner-only: 404 in a member cell (docs/multi-user.md "Member mode").
export const GET = ownerOnly(glosGET);
export const POST = ownerOnly(glosPOST);
