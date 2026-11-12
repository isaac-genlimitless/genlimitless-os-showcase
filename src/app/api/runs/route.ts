import { NextRequest, NextResponse } from "next/server";
import { childRuns, getRun, jobTotals, liveChatRun, listRuns, runEvents, stopChat, stopRun, usageTotals } from "@/lib/agents/runs";

// Agent flight recorder (Activity page + the chat's live "working" bubble).
// GET                      → recent runs + token/cost totals (24h and 7d)
// GET ?agent=slug          → recent runs for one agent
// GET ?id=N[&after=E]      → one run and its events (after event id E, for live polling)
// GET ?live=<thread>       → the chat run currently answering that conversation, and its latest step
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const live = sp.get("live");
  if (live) return NextResponse.json(liveChatRun(live) || { run: null, last: null });

  const id = Number(sp.get("id"));
  if (id) {
    const run = getRun(id);
    if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ run, events: runEvents(id, Number(sp.get("after") || 0)), handoffs: childRuns(id), job: jobTotals(id) });
  }

  return NextResponse.json({
    runs: listRuns({ agent: sp.get("agent") || undefined, limit: Number(sp.get("limit") || 60) }),
    today: usageTotals(24),
    week: usageTotals(24 * 7),
  });
}

// Owner's Stop button: { id } stops one run; { thread } stops whatever is answering that chat.
export async function POST(req: NextRequest) {
  const { id, thread } = await req.json().catch(() => ({}));
  if (id) return NextResponse.json(stopRun(Number(id)));
  if (thread) return NextResponse.json(stopChat(String(thread)));
  return NextResponse.json({ error: "id or thread is required" }, { status: 400 });
}
