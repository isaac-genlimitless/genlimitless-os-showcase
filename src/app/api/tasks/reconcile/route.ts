import { NextResponse } from "next/server";
import { runTaskReconcile, lastReconcileAt } from "@/lib/task-reconcile";
import { logIssue } from "@/lib/db";

// POST starts a "check for finished tasks" pass in the background (it takes a minute or more) and
// returns right away; the result is posted in chat. It only ever marks tasks done (reversible).
export async function POST() {
  void runTaskReconcile({ reason: "manual" }).catch((err: any) =>
    logIssue("api:task_reconcile", "Manual task reconcile failed", err?.message || String(err))
  );
  return NextResponse.json({ started: true }, { status: 202 });
}

export async function GET() {
  return NextResponse.json({ last_ok: lastReconcileAt() });
}
