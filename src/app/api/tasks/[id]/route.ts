import { NextRequest, NextResponse } from "next/server";
import { getTask, updateTask } from "@/lib/tasks";

type Ctx = { params: Promise<{ id: string }> };

// No DELETE export on purpose: tasks are completed (status='done'), never removed.

export async function GET(_req: NextRequest, { params }: Ctx) {
  const t = getTask(Number((await params).id));
  if (!t) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ task: t });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const id = Number((await params).id);
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const input = await req.json().catch(() => null);
  if (!input || typeof input !== "object") return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  try {
    return NextResponse.json({ task: updateTask(id, input) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
