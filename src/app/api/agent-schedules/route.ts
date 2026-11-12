import { NextResponse } from "next/server";
import { listAgentSchedules, setAgentScheduleEnabled } from "@/lib/agent-schedules";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ schedules: listAgentSchedules() });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    setAgentScheduleEnabled(Number(body.id), !!body.enabled);
    return NextResponse.json({ schedules: listAgentSchedules() });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
