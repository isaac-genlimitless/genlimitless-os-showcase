import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { refuseTestFixture } from "@/lib/data-dir";
import {
  addLearning,
  agentChanges,
  handleEscalation,
  listAgents,
  listApprovalRequests,
  listEscalations,
  listLearnings,
  listPriorities,
  recentActivity,
  restoreAgent,
  retireAgent,
  setLearningStatus,
  setPriority,
  updateAgent,
} from "@/lib/agents/registry";
import { permsFor } from "@/lib/agents/runtime";
import { decideApproval } from "@/lib/agents/approvals";
import { listEmailDrafts } from "@/lib/email-drafts";

// Owner's view of and control over the agent team (the Team page).

export async function GET() {
  const agents = listAgents(true).map((a) => {
    const p = permsFor(a);
    return {
      ...a,
      tools: [...p.builtins].filter((t) => t !== "Task").concat([...p.mcp]),
      learnings: listLearnings(a.slug),
      raw_signals: (db.prepare(`SELECT COUNT(*) c FROM agent_learnings WHERE agent_slug=? AND status='raw'`).get(a.slug) as { c: number }).c,
    };
  });
  const majorFixes = (db.prepare(`SELECT COUNT(*) c FROM fix_proposals WHERE status='pending_approval'`).get() as { c: number }).c;
  const emailDrafts = listEmailDrafts("pending_approval").length;
  return NextResponse.json({
    agents,
    approvals: listApprovalRequests("pending"),
    escalations: listEscalations("open"),
    priorities: listPriorities(),
    activity: recentActivity(48),
    changes: agentChanges(undefined, 30),
    majorFixes,
    emailDrafts,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  // A test run once rewrote the Marketing Director's live instructions through here.
  const refused = [body.lesson, body.instructions, body.objective, body.responsibilities, body.title, body.name].map(refuseTestFixture).find(Boolean);
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  try {
    switch (body.action) {
      case "update_agent": {
        const { slug, objective, responsibilities, instructions, default_model, default_effort } = body;
        return NextResponse.json(updateAgent(slug, { objective, responsibilities, instructions, default_model, default_effort }, "owner", body.reason || "edited by Owner on the Team page"));
      }
      case "add_learning":
        return NextResponse.json(addLearning(body.slug, body.lesson, "owner"));
      case "retire_learning":
        return NextResponse.json(setLearningStatus(body.id, "retired", "owner", "retired by Owner on the Team page"));
      case "retire_agent":
        return NextResponse.json(retireAgent(body.slug, "owner", body.reason || "retired by Owner"));
      case "restore_agent":
        return NextResponse.json(restoreAgent(body.slug, "owner", body.reason || "restored by Owner"));
      case "handle_escalation":
        return NextResponse.json(handleEscalation(body.id, "dismissed by Owner"));
      case "set_priority":
        return NextResponse.json(setPriority(body));
      case "decide_approval":
        return NextResponse.json(await decideApproval(body.id, body.decision === "approve" ? "approve" : "decline"));
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
