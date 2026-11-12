import { NextRequest, NextResponse } from "next/server";
import { createTask, listTasks } from "@/lib/tasks";
import { refuseTestFixture } from "@/lib/data-dir";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const s = sp.get("status");
  const status = s === "open" || s === "done" || s === "all" ? s : "all";
  const category = sp.get("category") || undefined;
  return NextResponse.json({ tasks: listTasks({ status, category }) });
}

export async function POST(req: NextRequest) {
  const input = await req.json().catch(() => null);
  if (!input || typeof input !== "object") return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  if (typeof input.title === "string") {
    const refused = refuseTestFixture(input.title);
    if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  }
  try {
    return NextResponse.json({ task: createTask(input, "owner") }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
