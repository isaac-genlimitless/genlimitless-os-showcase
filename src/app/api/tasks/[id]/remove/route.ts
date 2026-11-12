import { NextRequest, NextResponse } from "next/server";
import { removeTask } from "@/lib/task-remove";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Ctx) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  const t = await removeTask(id);
  if (!t) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, id });
}
