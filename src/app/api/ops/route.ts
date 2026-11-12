import { ownerOnly } from "@/lib/instance";
import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { applyFixProposal, securitySnapshot } from "@/lib/ops";
import { runOpsReview } from "@/lib/agents/runtime";
import { runE2E } from "@/lib/selftest";

let reviewRunning = false;

async function glosGET() {
  const proposals = db
    .prepare(`SELECT * FROM fix_proposals ORDER BY created_at DESC LIMIT 100`)
    .all();
  return NextResponse.json({ proposals, reviewRunning });
}

// { action: "review" | "test" | "approve" | "dismiss", id? }
async function glosPOST(req: NextRequest) {
  const { action, id } = await req.json();
  if (action === "test") return NextResponse.json(await runE2E());
  if (action === "security_snapshot") {
    return NextResponse.json({ snapshot: await securitySnapshot() });
  }
  if (action === "review") {
    if (!reviewRunning) {
      reviewRunning = true;
      runOpsReview().finally(() => (reviewRunning = false));
    }
    return NextResponse.json({ started: true });
  }
  if (action === "approve" && id) {
    applyFixProposal(id, "owner").catch(() => {}); // runs in background; status shows on the proposal
    return NextResponse.json({ started: true });
  }
  if (action === "dismiss" && id) {
    db.prepare(`UPDATE fix_proposals SET status='dismissed' WHERE id=? AND status IN ('pending_approval','pending_cos_review','sent_back')`).run(id);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

// Owner-only: 404 in a member cell (docs/multi-user.md "Member mode").
export const GET = ownerOnly(glosGET);
export const POST = ownerOnly(glosPOST);
