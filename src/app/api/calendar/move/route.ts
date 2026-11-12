import { ownerName } from "@/lib/instance";
import { NextRequest, NextResponse } from "next/server";
import { CalendarNotConnected, externalAttendees, getEvent, updateEvent } from "@/lib/gcal";
import { createApprovalRequest } from "@/lib/agents/registry";
import { fmtCentral } from "@/lib/time";

// Drag-to-move / drag-to-resize from the Calendar tab. Only start and end are ever changed.
// Unlike PATCH /api/calendar (Owner editing directly), this enforces the same guardrail as the
// agents' update_calendar_event tool: an event with outside guests is never touched here, it
// becomes an approval request so guests are only notified once Owner approves.
// Attendees always come from the server-side event, never from the client.

function err(e: any) {
  const status = e instanceof CalendarNotConnected ? 409 : 500;
  return NextResponse.json({ error: e.message, connected: !(e instanceof CalendarNotConnected) }, { status });
}

export async function POST(req: NextRequest) {
  let input: any;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { id, account, start, end } = input || {};
  if (!id || !account || !start || !end) return NextResponse.json({ error: "id, account, start and end are required" }, { status: 400 });
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e) || !(e > s)) return NextResponse.json({ error: "The end has to be after the start." }, { status: 400 });

  try {
    const current = await getEvent(id, account);
    if (current.recurring || current.allDay || current.status === "cancelled") {
      return NextResponse.json({ error: "This event can't be moved by dragging" }, { status: 400 });
    }
    const outside = await externalAttendees(current.attendees);
    if (outside.length) {
      const r = createApprovalRequest({
        requested_by: "owner",
        action: "calendar_update",
        title: `Move "${current.summary}" from ${fmtCentral(current.start)} to ${fmtCentral(start)}, notifying ${outside.join(", ")}`,
        reason: `${ownerName()} dragged this event on the Calendar page`,
        payload: { id, account, start, end },
      });
      return NextResponse.json({ approval: true, request_id: r.request_id }, { status: 202 });
    }
    const event = await updateEvent({ id, account, start, end, sendUpdates: "none" });
    return NextResponse.json({ event });
  } catch (e2) {
    return err(e2);
  }
}
