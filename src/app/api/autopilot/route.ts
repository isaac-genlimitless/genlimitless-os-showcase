import { NextRequest, NextResponse } from "next/server";
import { declineSuggestion, holdSend, setPaused, turnOffAutopilot, turnOnAutopilot } from "@/lib/autopilot";
import { autopilotPanel } from "@/lib/decisions";

// Owner's Autopilot controls (Decisions page). This route is the ONLY way Autopilot gets turned on:
// no agent tool can reach it (agents have no HTTP/Bash/WebFetch), and every request passes the login proxy.

export async function GET() {
  return NextResponse.json(autopilotPanel());
}

// { action: "turn_on", kind, recipient, label?, delay_min? } | { action: "turn_off", id }
// { action: "decline", kind, recipient, label? } | { action: "hold", id } | { action: "pause" | "resume" }
export async function POST(req: NextRequest) {
  const b = (await req.json().catch(() => ({}))) as Record<string, any>;
  try {
    switch (b.action) {
      case "turn_on":
        return NextResponse.json({ trust: turnOnAutopilot({ kind: b.kind, recipient: String(b.recipient || ""), label: b.label, delay_min: b.delay_min }), ...autopilotPanel() });
      case "turn_off":
        return NextResponse.json({ trust: turnOffAutopilot(Number(b.id)), ...autopilotPanel() });
      case "decline":
        return NextResponse.json({ ...declineSuggestion(b.kind, String(b.recipient || ""), b.label), ...autopilotPanel() });
      case "hold":
        return NextResponse.json({ send: holdSend(Number(b.id)), ...autopilotPanel() });
      case "pause":
        return NextResponse.json({ ...setPaused(true), ...autopilotPanel() });
      case "resume":
        return NextResponse.json({ ...setPaused(false), ...autopilotPanel() });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
