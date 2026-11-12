import { NextRequest, NextResponse } from "next/server";
import { previewTurnLive, undoTurn, redoTurn, UndoError } from "@/lib/undo";

// Owner's Undo / Redo for an AI reply. Reachable only from the UI (not an agent tool).

const id = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function GET(req: NextRequest) {
  const chatId = id(req.nextUrl.searchParams.get("chat_id"));
  if (!chatId) return NextResponse.json({ error: "chat_id must be a positive whole number" }, { status: 400 });
  return NextResponse.json(await previewTurnLive(chatId));
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send JSON: {chat_id, action}" }, { status: 400 });
  }
  const chatId = id(body?.chat_id);
  if (!chatId) return NextResponse.json({ error: "chat_id must be a positive whole number" }, { status: 400 });
  if (body?.action !== "undo" && body?.action !== "redo") return NextResponse.json({ error: "action must be 'undo' or 'redo'" }, { status: 400 });
  let overwrite: number[] = [];
  if (body.overwrite !== undefined) {
    if (!Array.isArray(body.overwrite) || body.overwrite.some((n: unknown) => !id(n))) {
      return NextResponse.json({ error: "overwrite must be a list of action ids" }, { status: 400 });
    }
    overwrite = body.overwrite.map(Number);
  }
  try {
    const summary = body.action === "undo" ? await undoTurn(chatId, { overwrite }) : await redoTurn(chatId, { overwrite });
    return NextResponse.json(summary);
  } catch (e) {
    if (e instanceof UndoError) return NextResponse.json({ error: e.message }, { status: e.status === 404 ? 409 : e.status });
    return NextResponse.json({ error: (e as Error).message || "Undo failed" }, { status: 500 });
  }
}
