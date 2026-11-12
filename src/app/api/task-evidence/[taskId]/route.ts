import { NextRequest, NextResponse } from "next/server";
import { getTask } from "@/lib/tasks";
import { confirmLikelyDone, dismissLikelyDone, revertAutoClose } from "@/lib/task-evidence";

type Ctx = { params: Promise<{ taskId: string }> };

// No DELETE export on purpose (same convention as /api/tasks/[id]).
export async function POST(req: NextRequest, { params }: Ctx) {
  const id = Number((await params).taskId);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "bad task id" }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  const action = (body as { action?: unknown }).action;
  if (action !== "done" && action !== "not_yet" && action !== "revert") {
    return NextResponse.json({ error: "action must be done, not_yet or revert" }, { status: 400 });
  }
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const task = action === "done" ? confirmLikelyDone(id, "owner") : action === "not_yet" ? dismissLikelyDone(id, "owner") : revertAutoClose(id, "owner");
    return NextResponse.json({ task });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
