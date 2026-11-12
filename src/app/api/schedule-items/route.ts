import { NextRequest, NextResponse } from "next/server";
import { CalendarNotConnected, listEvents } from "@/lib/gcal";
import { approveScheduleItem, editScheduleItem, listScheduleItems, rejectScheduleItem } from "@/lib/schedule";
import { centralDayBounds } from "@/lib/time";

// Backs the ScheduleReviewModal (a ```schedule-review YYYY-MM-DD``` block in chat). GET returns both the day's live calendar events
// (read-only context) and the Chief of Staff's proposed blocks; PATCH approve/reject/edit acts on
// one proposed item only. Nothing here ever writes to a calendar except an explicit approve.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date");
  if (!date || !DATE_RE.test(date)) return NextResponse.json({ error: "date (YYYY-MM-DD) is required" }, { status: 400 });
  const proposed = listScheduleItems(date);
  const { start, end } = centralDayBounds(date);
  try {
    const existing = await listEvents({ timeMin: start, timeMax: end });
    return NextResponse.json({ date, proposed, existing, calendarConnected: true });
  } catch (e) {
    const connected = !(e instanceof CalendarNotConnected);
    return NextResponse.json({ date, proposed, existing: [], calendarConnected: connected, calendarError: (e as Error).message });
  }
}

export async function PATCH(req: NextRequest) {
  const { id, action, title, start, end, description, account } = await req.json();
  if (!id || !action) return NextResponse.json({ error: "id and action are required" }, { status: 400 });
  try {
    if (action === "approve") return NextResponse.json(await approveScheduleItem(id));
    if (action === "reject") return NextResponse.json(rejectScheduleItem(id));
    if (action === "edit") return NextResponse.json(editScheduleItem(id, { title, start, end, description, account }));
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    const status = e instanceof CalendarNotConnected ? 409 : 400;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
