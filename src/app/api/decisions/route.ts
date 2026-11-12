import { NextResponse } from "next/server";
import { autopilotPanel, listDecisions } from "@/lib/decisions";

// Everything waiting on Owner, in one list. Read-only; decisions go through the owning routes.
export async function GET() {
  return NextResponse.json({ ...listDecisions(), autopilot: autopilotPanel() });
}
