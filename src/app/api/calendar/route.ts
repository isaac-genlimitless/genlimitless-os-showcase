import { NextRequest, NextResponse } from "next/server";
import { CalendarNotConnected, cancelEvent, connectedCalendarAccounts, createEvent, listEvents, updateEvent } from "@/lib/gcal";

// The Calendar tab. Everything here is Owner acting on his own calendar from the UI, so guests
// are notified directly (the agents' approval gates live in their tools, not here).

function err(e: any) {
  const status = e instanceof CalendarNotConnected ? 409 : 500;
  return NextResponse.json({ error: e.message, connected: !(e instanceof CalendarNotConnected) }, { status });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const accounts = await connectedCalendarAccounts();
  if (!accounts.length) return NextResponse.json({ connected: false, accounts, events: [] });
  try {
    if (sp.get("now")) {
      // What's on right now (or starting within 15 minutes), to title a recording.
      const now = Date.now();
      const events = await listEvents({ timeMin: new Date(now - 3 * 3600e3).toISOString(), timeMax: new Date(now + 15 * 60e3).toISOString() });
      const current = events
        .filter((e) => !e.allDay && Date.parse(e.start) <= now + 15 * 60e3 && Date.parse(e.end) >= now)
        .sort((a, b) => Math.abs(Date.parse(a.start) - now) - Math.abs(Date.parse(b.start) - now))[0];
      return NextResponse.json({ connected: true, accounts, event: current || null });
    }
    const start = sp.get("start");
    const end = sp.get("end");
    if (!start || !end) return NextResponse.json({ error: "start and end are required" }, { status: 400 });
    return NextResponse.json({ connected: true, accounts, events: await listEvents({ timeMin: start, timeMax: end }) });
  } catch (e) {
    return err(e);
  }
}

export async function POST(req: NextRequest) {
  const input = await req.json();
  if (!input.summary || !input.start || !input.end) return NextResponse.json({ error: "summary, start and end are required" }, { status: 400 });
  try {
    const attendees: string[] = Array.isArray(input.attendees) ? input.attendees.filter(Boolean) : [];
    const event = await createEvent({
      summary: input.summary,
      start: input.start,
      end: input.end,
      description: input.description || undefined,
      attendees,
      account: input.account || undefined,
      sendUpdates: attendees.length ? "all" : "none",
    });
    return NextResponse.json({ event }, { status: 201 });
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(req: NextRequest) {
  const input = await req.json();
  if (!input.id || !input.account) return NextResponse.json({ error: "id and account are required" }, { status: 400 });
  try {
    const event = await updateEvent({
      id: input.id,
      account: input.account,
      summary: input.summary,
      start: input.start,
      end: input.end,
      description: input.description,
      attendees: Array.isArray(input.attendees) ? input.attendees : undefined,
      sendUpdates: input.notify ? "all" : "none",
    });
    return NextResponse.json({ event });
  } catch (e) {
    return err(e);
  }
}

export async function DELETE(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const id = sp.get("id");
  const account = sp.get("account");
  if (!id || !account) return NextResponse.json({ error: "id and account are required" }, { status: 400 });
  try {
    return NextResponse.json(await cancelEvent(id, account, sp.get("notify") ? "all" : "none"));
  } catch (e) {
    return err(e);
  }
}
