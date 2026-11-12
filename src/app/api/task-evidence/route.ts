import { NextRequest, NextResponse } from "next/server";
import { listAutoClosed, listEvidence, listLikelyDone } from "@/lib/task-evidence";

export const dynamic = "force-dynamic";

// Read-only. view=likely_done | auto_closed | log (&task_id, &limit)
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const view = sp.get("view") || "likely_done";
  const limit = sp.get("limit") ? Number(sp.get("limit")) : undefined;
  if (view === "likely_done") return NextResponse.json({ likely_done: listLikelyDone() });
  if (view === "auto_closed") return NextResponse.json({ auto_closed: listAutoClosed(limit && limit > 0 ? limit : 7) });
  if (view === "log") {
    const tid = sp.get("task_id");
    return NextResponse.json({ evidence: listEvidence({ task_id: tid ? Number(tid) : undefined, limit }) });
  }
  return NextResponse.json({ error: "view must be likely_done, auto_closed or log" }, { status: 400 });
}
