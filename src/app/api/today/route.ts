import { NextResponse } from "next/server";
import { listTasks } from "@/lib/tasks";
import { commitmentsOverview } from "@/lib/commitments";
import { listDecisions } from "@/lib/decisions";
import { listScheduledSends } from "@/lib/autopilot";
import { listCaptures } from "@/lib/captures";
import { listPriorities } from "@/lib/agents/registry";
import { centralDateKey, centralDayBounds } from "@/lib/time";

// The Today page (home screen that isn't a chat): one read of everything that matters right now.
// Read-only. The calendar is best-effort: a disconnected calendar just shows no events.

type TodayEvent = { summary: string; start: string; end: string; allDay?: boolean };
type CalendarResult = { events: TodayEvent[]; error: string | null };

// The page reloads every 30s; the calendar is fetched live from Google/iCloud, which can be slow.
// Reuse a result for a minute, and never make the page wait more than CALENDAR_BUDGET_MS for it:
// a slow fetch keeps going in the background and fills the cache for the next load.
const CALENDAR_TTL_MS = 60_000;
const CALENDAR_BUDGET_MS = 4_000;
let calCache: { date: string; at: number; result: CalendarResult } | null = null;
let calInFlight: { date: string; promise: Promise<CalendarResult> } | null = null;

async function fetchCalendar(today: string): Promise<CalendarResult> {
  try {
    const { isCalendarConnected, listEvents } = await import("@/lib/gcal");
    if (!(await isCalendarConnected())) return { events: [], error: "Calendar not connected" };
    const { start, end } = centralDayBounds(today);
    const events = (await listEvents({ timeMin: start, timeMax: end }))
      .filter((e) => e.status !== "cancelled")
      .map((e) => ({ summary: e.summary, start: e.start, end: e.end, allDay: e.allDay }));
    return { events, error: null };
  } catch (e) {
    return { events: [], error: (e as Error).message };
  }
}

async function todaysCalendar(today: string): Promise<CalendarResult> {
  if (calCache && calCache.date === today && Date.now() - calCache.at < CALENDAR_TTL_MS) return calCache.result;
  if (!calInFlight || calInFlight.date !== today) {
    const promise = fetchCalendar(today).then((result) => {
      calCache = { date: today, at: Date.now(), result };
      return result;
    }).finally(() => { if (calInFlight?.promise === promise) calInFlight = null; });
    calInFlight = { date: today, promise };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<null>((r) => { timer = setTimeout(() => r(null), CALENDAR_BUDGET_MS); });
  const result = await Promise.race([calInFlight.promise, slow]);
  clearTimeout(timer);
  if (result) return result;
  // Still loading: show the last known events for today if there are any, else say it's slow.
  if (calCache && calCache.date === today) return calCache.result;
  return { events: [], error: "Calendar is slow to respond; it will appear on the next refresh." };
}

export async function GET() {
  const today = centralDateKey();
  const open = listTasks({ status: "open" });
  const { events, error: calendarError } = await todaysCalendar(today);
  const decisions = listDecisions();
  return NextResponse.json({
    date: today,
    priorities: listPriorities().slice(0, 5),
    events,
    calendar_error: calendarError,
    tasks_due: open.filter((t) => t.due_date && t.due_date <= today),
    tasks_open: open.length,
    commitments: commitmentsOverview(today),
    decisions: { total: decisions.items.length, counts: decisions.counts, top: decisions.items.slice(0, 5) },
    autopilot_scheduled: listScheduledSends(),
    captures: listCaptures(8),
  });
}
