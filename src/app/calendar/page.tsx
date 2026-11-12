"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { setOsContext } from "@/lib/os-context";
import { addMinutesIso } from "@/lib/time";
import { CentralDateTimeInput } from "@/components/CentralDateTimeInput";

// Calendar: every connected Google account merged into one week / day / month view. Click an
// empty slot to add an event; click an event to edit, cancel, record it, or start prep notes.

type CalEvent = {
  id: string;
  account: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  attendees: string[];
  status: string;
  htmlLink: string;
  allDay?: boolean;
  recurring?: boolean;
};
type Mode = "week" | "day" | "month";

const HOUR_PX = 48;
const PALETTE = ["#d2ae6d", "#2ea3f2", "#7fbf7f", "#c792ea", "#f78c6c"];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const startOfWeek = (d: Date) => addDays(startOfDay(d), -d.getDay());
const fmtTime = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** "2026-09-24" style date-only strings (all-day events) are local days, not UTC midnight. */
function parseWhen(s: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
}

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function range(mode: Mode, anchor: Date): [Date, Date] {
  if (mode === "day") return [startOfDay(anchor), addDays(startOfDay(anchor), 1)];
  if (mode === "week") return [startOfWeek(anchor), addDays(startOfWeek(anchor), 7)];
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = startOfWeek(first);
  return [gridStart, addDays(gridStart, 42)];
}

// Dates depend on the viewer's time zone, so the calendar renders in the browser only.
export default function CalendarPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <CalendarView /> : <div className="p-8 text-sm text-muted">Loading calendar…</div>;
}

function CalendarView() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<CalEvent | null>(null);
  const [draft, setDraft] = useState<{ start: Date; end: Date } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const scroller = useRef<HTMLDivElement>(null);

  const [from, to] = useMemo(() => range(mode, anchor), [mode, anchor]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/calendar?start=${encodeURIComponent(from.toISOString())}&end=${encodeURIComponent(to.toISOString())}`);
      const d = await res.json();
      setConnected(d.connected !== false);
      setAccounts(d.accounts || []);
      setEvents(d.events || []);
      setError(res.ok ? null : d.error);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Start the day view scrolled to the working day.
  useEffect(() => {
    if (scroller.current && mode !== "month") scroller.current.scrollTop = HOUR_PX * 7.5;
  }, [mode]);

  useEffect(() => {
    setOsContext(
      selected
        ? `Calendar: event "${selected.summary}" ${parseWhen(selected.start).toLocaleString()} (id ${selected.id}, account ${selected.account})`
        : `Calendar: ${mode} view, ${from.toDateString()} to ${addDays(to, -1).toDateString()}`
    );
    return () => setOsContext(null);
  }, [selected, mode, from, to]);

  const color = (account: string) => PALETTE[Math.max(0, accounts.indexOf(account)) % PALETTE.length];

  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  function showToast(kind: "info" | "error", text: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ kind, text });
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }

  // Drag / resize: optimistic move, then the server decides (events with outside guests become an
  // approval request and snap back; nothing is changed until Owner approves).
  async function moveEvent(ev: CalEvent, start: Date, end: Date) {
    const restore = () => setEvents((list) => list.map((e) => (e.id === ev.id ? ev : e)));
    setEvents((list) => list.map((e) => (e.id === ev.id ? { ...e, start: start.toISOString(), end: end.toISOString() } : e)));
    setPendingIds((p) => new Set(p).add(ev.id));
    try {
      const res = await fetch("/api/calendar/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ev.id, account: ev.account, start: start.toISOString(), end: end.toISOString() }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.status === 202) {
        restore();
        showToast("info", `Sent for your approval: "${ev.summary}" will move once you approve it (Team -> Needs your approval).`);
      } else if (!res.ok) {
        restore();
        showToast("error", `Couldn't move "${ev.summary}": ${d.error || res.statusText || "unknown error"}`);
      } else {
        load();
      }
    } catch (e: any) {
      restore();
      showToast("error", `Couldn't move "${ev.summary}": ${e.message}`);
    } finally {
      setPendingIds((p) => {
        const n = new Set(p);
        n.delete(ev.id);
        return n;
      });
    }
  }

  function shift(dir: number) {
    setAnchor((a) => (mode === "day" ? addDays(a, dir) : mode === "week" ? addDays(a, 7 * dir) : new Date(a.getFullYear(), a.getMonth() + dir, 1)));
  }

  const title =
    mode === "month"
      ? anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" })
      : mode === "day"
      ? anchor.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
      : `${from.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${addDays(to, -1).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 md:px-8 pt-6 pb-4 border-b border-panel-border flex items-center gap-4 flex-wrap">
        <h1 className="font-display text-2xl tracking-wide mr-2">Calendar</h1>
        <div className="flex items-center gap-1">
          <button onClick={() => setAnchor(new Date())} className="text-xs border border-panel-border rounded px-3 py-1.5 min-h-11 md:min-h-0 hover:border-gold">Today</button>
          <button onClick={() => shift(-1)} aria-label="Previous" className="text-sm px-2 py-1 w-11 h-11 md:w-auto md:h-auto flex items-center justify-center hover:bg-wash-2 rounded-lg">‹</button>
          <button onClick={() => shift(1)} aria-label="Next" className="text-sm px-2 py-1 w-11 h-11 md:w-auto md:h-auto flex items-center justify-center hover:bg-wash-2 rounded-lg">›</button>
        </div>
        <div className="text-sm font-medium" data-testid="calendar-range">{title}</div>
        {loading && <span className="text-xs text-muted">Loading…</span>}
        <div className="w-full md:w-auto md:ml-auto flex flex-wrap items-center gap-2 md:gap-3">
          <div className="flex gap-2 text-[11px] text-muted">
            {accounts.map((a) => (
              <span key={a} className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: color(a) }} />
                {a}
              </span>
            ))}
          </div>
          <div className="flex border border-panel-border rounded overflow-hidden text-xs">
            {(["day", "week", "month"] as Mode[]).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`px-3 py-1.5 min-h-11 md:min-h-0 capitalize ${mode === m ? "bg-gold text-black font-semibold" : "hover:bg-wash-2"}`}>
                {m}
              </button>
            ))}
          </div>
          <button
            onClick={() => {
              const s = new Date();
              s.setMinutes(s.getMinutes() < 30 ? 30 : 60, 0, 0);
              setDraft({ start: s, end: new Date(s.getTime() + 30 * 60e3) });
            }}
            disabled={!connected}
            className="text-xs bg-gold text-black font-semibold rounded px-3 py-1.5 min-h-11 md:min-h-0 hover:bg-gold-soft disabled:opacity-50"
          >
            + Event
          </button>
        </div>
      </header>

      {connected === false ? (
        <div className="p-10 text-sm text-muted">
          No calendar connected yet. Connect a Gmail account (its app password also gives calendar access) in <Link href="/analytics" className="text-accent underline">Settings</Link>.
        </div>
      ) : (
        <>
          {error && <div className="px-8 py-2 text-xs text-danger border-b border-panel-border">{error}</div>}
          {mode === "month" ? (
            <MonthGrid from={from} anchor={anchor} events={events} color={color} onPick={setSelected} onDay={(d) => { setAnchor(d); setMode("day"); }} />
          ) : (
            <TimeGrid
              scrollerRef={scroller}
              days={mode === "day" ? [from] : Array.from({ length: 7 }, (_, i) => addDays(from, i))}
              events={events}
              now={now}
              color={color}
              onPick={setSelected}
              onSlot={(start) => setDraft({ start, end: new Date(start.getTime() + 30 * 60e3) })}
              onMove={moveEvent}
              pendingIds={pendingIds}
            />
          )}
        </>
      )}

      {toast && (
        <div
          data-testid="calendar-toast"
          data-kind={toast.kind}
          className={`fixed bottom-4 left-4 right-4 md:left-auto md:right-6 md:bottom-6 z-50 md:max-w-md flex items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-2xl bg-panel ${
            toast.kind === "error" ? "border-danger text-danger" : "border-panel-border"
          }`}
        >
          <div className="flex-1">{toast.text}</div>
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="text-muted hover:text-foreground">✕</button>
        </div>
      )}

      {selected && (
        <EventPanel
          ev={selected}
          color={color(selected.account)}
          onClose={() => setSelected(null)}
          onChanged={() => {
            setSelected(null);
            load();
          }}
          onRecord={() =>
            router.push(
              `/meetings?${new URLSearchParams({ event: selected.id, account: selected.account, title: selected.summary, attendees: selected.attendees.join(",") })}`
            )
          }
        />
      )}
      {draft && (
        <EventForm
          accounts={accounts}
          initial={{ summary: "", description: "", attendees: "", start: draft.start, end: draft.end, account: accounts.find((a) => a === "owner@example.com") || accounts[0] || "" }}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- grids

const dayKey = (d: Date) => toLocalInput(d).slice(0, 10);
const SNAP_MIN = 15;
const canDrag = (e: CalEvent) => !e.allDay && !e.recurring && e.status !== "cancelled";

type DragState = { id: string; start: Date; end: Date };
type DispEv = CalEvent & { _k?: string };

function TimeGrid({
  days,
  events,
  now,
  color,
  onPick,
  onSlot,
  onMove,
  pendingIds,
  scrollerRef,
}: {
  days: Date[];
  events: CalEvent[];
  now: Date;
  color: (a: string) => string;
  onPick: (e: CalEvent) => void;
  onSlot: (d: Date) => void;
  onMove: (e: CalEvent, start: Date, end: Date) => void;
  pendingIds: Set<string>;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const suppressClick = useRef(false);

  // While dragging, the event is rendered at its in-flight slot; its key stays put.
  const shown: DispEv[] = drag
    ? events.map((e) => (e.id === drag.id ? { ...e, _k: e.id + e.start, start: drag.start.toISOString(), end: drag.end.toISOString() } : e))
    : events;

  function beginDrag(x: React.PointerEvent, ev: CalEvent, kind: "move" | "resize") {
    if (x.button !== 0 || !canDrag(ev) || pendingIds.has(ev.id)) return;
    if (kind === "resize") x.stopPropagation();
    const btn = (x.currentTarget as HTMLElement).closest("button") as HTMLElement;
    const rect = btn.getBoundingClientRect();
    const grabOffsetY = x.clientY - rect.top;
    const x0 = x.clientX;
    const y0 = x.clientY;
    const origStart = parseWhen(ev.start);
    const origEnd = parseWhen(ev.end);
    const durMs = origEnd.getTime() - origStart.getTime();
    const dayStart = startOfDay(origStart);
    const origEndMin = Math.round((origEnd.getTime() - dayStart.getTime()) / 60000);
    const startMin = origStart.getHours() * 60 + origStart.getMinutes();
    let moved = false;
    let cancelled = false;
    let last: { start: Date; end: Date } | null = null;
    const columns = () => Array.from(scrollerRef.current?.querySelectorAll<HTMLElement>("[data-day-col]") ?? []);
    const dayOf = (col: HTMLElement) => {
      const [yy, mm, dd] = (col.dataset.dayCol || "").split("-").map(Number);
      return new Date(yy, mm - 1, dd);
    };

    const onPointerMove = (pe: PointerEvent) => {
      if (cancelled) return;
      if (!moved) {
        if (Math.hypot(pe.clientX - x0, pe.clientY - y0) < 4) return;
        moved = true;
        document.body.style.userSelect = "none";
      }
      const cols = columns();
      if (!cols.length) return;
      let s: Date;
      let e: Date;
      if (kind === "move") {
        let col = cols.find((c) => {
          const r = c.getBoundingClientRect();
          return pe.clientX >= r.left && pe.clientX < r.right;
        });
        if (!col) col = pe.clientX < cols[0].getBoundingClientRect().left ? cols[0] : cols[cols.length - 1];
        const day = dayOf(col);
        const durMin = Math.round(durMs / 60000);
        const raw = Math.round((((pe.clientY - col.getBoundingClientRect().top - grabOffsetY) / HOUR_PX) * 60) / SNAP_MIN) * SNAP_MIN;
        const mins = Math.min(Math.max(0, raw), Math.max(0, 1440 - durMin));
        s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, mins);
        e = new Date(s.getTime() + durMs);
      } else {
        const deltaMin = Math.round((((pe.clientY - y0) / HOUR_PX) * 60) / SNAP_MIN) * SNAP_MIN;
        const endMin = Math.min(Math.max(origEndMin + deltaMin, startMin + SNAP_MIN), Math.max(1440, startMin + SNAP_MIN));
        s = origStart;
        e = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), 0, endMin);
      }
      last = { start: s, end: e };
      setDrag({ id: ev.id, start: s, end: e });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKey);
      document.body.style.userSelect = "";
    };
    const finish = () => {
      cleanup();
      if (moved) {
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
      }
    };
    function onPointerUp() {
      finish();
      const l = last;
      setDrag(null);
      if (moved && !cancelled && l && (l.start.getTime() !== origStart.getTime() || l.end.getTime() !== origEnd.getTime())) onMove(ev, l.start, l.end);
    }
    function onPointerCancel() {
      cancelled = true;
      finish();
      setDrag(null);
    }
    function onKey(ke: KeyboardEvent) {
      if (ke.key === "Escape") {
        cancelled = true;
        setDrag(null);
      }
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKey);
  }

  const allDay = (d: Date) => shown.filter((e) => e.allDay && parseWhen(e.start) <= d && parseWhen(e.end) > d);
  const timed = (d: Date) =>
    shown
      .filter((e) => !e.allDay && sameDay(parseWhen(e.start), d))
      .sort((a, b) => a.start.localeCompare(b.start));

  // Overlapping events share the column side by side.
  function layout(list: CalEvent[]) {
    const out: { ev: CalEvent; col: number; cols: number }[] = [];
    let group: { ev: CalEvent; col: number }[] = [];
    let groupEnd = 0;
    const flush = () => {
      const cols = Math.max(1, ...group.map((g) => g.col + 1));
      group.forEach((g) => out.push({ ...g, cols }));
      group = [];
    };
    for (const ev of list) {
      const s = parseWhen(ev.start).getTime();
      const e = parseWhen(ev.end).getTime();
      if (group.length && s >= groupEnd) flush();
      const used = new Set(group.filter((g) => parseWhen(g.ev.end).getTime() > s).map((g) => g.col));
      let col = 0;
      while (used.has(col)) col++;
      group.push({ ev, col });
      groupEnd = Math.max(groupEnd, e);
    }
    flush();
    return out;
  }

  const hasAllDay = days.some((d) => allDay(d).length);

  return (
    <div className="flex-1 min-h-0 overflow-x-auto flex flex-col" data-testid="calendar-grid-scroll">
      <div className={`flex-1 min-h-0 flex flex-col ${days.length > 1 ? "min-w-[640px]" : ""} md:min-w-0`}>
      <div className="flex border-b border-panel-border pl-14">
        {days.map((d) => (
          <div key={d.toISOString()} className={`flex-1 text-center py-2 text-xs ${sameDay(d, now) ? "text-accent font-semibold" : "text-muted"}`}>
            {d.toLocaleDateString("en-US", { weekday: "short" })} <span className="text-base ml-1">{d.getDate()}</span>
          </div>
        ))}
      </div>
      {hasAllDay && (
        <div className="flex border-b border-panel-border pl-14">
          {days.map((d) => (
            <div key={d.toISOString()} className="flex-1 p-1 space-y-1 min-w-0">
              {allDay(d).map((e) => (
                <button key={e.id + e.start} onClick={() => onPick(e)} className="block w-full truncate text-left text-[11px] rounded px-1.5 py-0.5 text-black" style={{ background: color(e.account) }}>
                  {e.summary}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div ref={scrollerRef} className="flex-1 overflow-y-auto">
        <div className="flex relative" style={{ height: HOUR_PX * 24 }}>
          <div className="w-14 shrink-0 relative">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="absolute right-2 text-[10px] text-muted -translate-y-1/2" style={{ top: h * HOUR_PX }}>
                {h === 0 ? "" : new Date(2000, 0, 1, h).toLocaleTimeString("en-US", { hour: "numeric" })}
              </div>
            ))}
          </div>
          {days.map((d) => (
            <div
              key={d.toISOString()}
              data-day-col={dayKey(d)}
              className="flex-1 relative border-l border-panel-border min-w-0"
              onClick={(e) => {
                if (suppressClick.current) return;
                const y = e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top;
                const mins = Math.floor((y / HOUR_PX) * 2) * 30;
                onSlot(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, mins));
              }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="absolute left-0 right-0 border-t border-panel-border/50" style={{ top: h * HOUR_PX }} />
              ))}
              {sameDay(d, now) && (
                <div className="absolute left-0 right-0 z-10 border-t-2 border-danger/50" style={{ top: (now.getHours() + now.getMinutes() / 60) * HOUR_PX }} />
              )}
              {layout(timed(d)).map(({ ev, col, cols }) => {
                const s = parseWhen(ev.start);
                const e = parseWhen(ev.end);
                const top = (s.getHours() + s.getMinutes() / 60) * HOUR_PX;
                const height = Math.max(18, ((e.getTime() - s.getTime()) / 3600e3) * HOUR_PX - 2);
                const draggable = canDrag(ev) && !pendingIds.has(ev.id);
                const dragging = drag?.id === ev.id;
                return (
                  <button
                    key={(ev as DispEv)._k ?? ev.id + ev.start}
                    onClick={(x) => {
                      x.stopPropagation();
                      if (suppressClick.current) return;
                      onPick(ev);
                    }}
                    onPointerDown={draggable ? (x) => beginDrag(x, ev, "move") : undefined}
                    data-testid="calendar-event"
                    data-event-id={ev.id}
                    className={`absolute rounded px-1.5 py-0.5 text-left text-[11px] leading-tight overflow-hidden text-black hover:brightness-110 border border-black/30 select-none ${draggable ? "cursor-grab" : ""}`}
                    style={{
                      top,
                      height,
                      left: `calc(${(col / cols) * 100}% + 2px)`,
                      width: `calc(${100 / cols}% - 4px)`,
                      background: color(ev.account),
                      opacity: dragging ? 0.7 : pendingIds.has(ev.id) ? 0.6 : 1,
                      touchAction: draggable ? "none" : undefined,
                      zIndex: dragging ? 20 : undefined,
                    }}
                  >
                    <div className="font-semibold truncate">{ev.summary}</div>
                    {height > 30 && <div className="opacity-80">{fmtTime(s)} – {fmtTime(e)}</div>}
                    {draggable && (
                      <div
                        data-testid="calendar-event-resize"
                        onPointerDown={(x) => beginDrag(x, ev, "resize")}
                        className="absolute left-0 right-0 bottom-0 h-1.5 cursor-ns-resize"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      </div>
    </div>
  );
}

function MonthGrid({ from, anchor, events, color, onPick, onDay }: { from: Date; anchor: Date; events: CalEvent[]; color: (a: string) => string; onPick: (e: CalEvent) => void; onDay: (d: Date) => void }) {
  const today = new Date();
  const cells = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  const on = (d: Date) =>
    events
      .filter((e) => (e.allDay ? parseWhen(e.start) <= d && parseWhen(e.end) > d : sameDay(parseWhen(e.start), d)))
      .sort((a, b) => a.start.localeCompare(b.start));
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="grid grid-cols-7 border-b border-panel-border">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="text-center text-xs text-muted py-2">{d}</div>
        ))}
      </div>
      <div className="flex-1 grid grid-cols-7 grid-rows-6">
        {cells.map((d) => {
          const list = on(d);
          return (
            <div key={d.toISOString()} className={`border-r border-b border-panel-border p-1 min-h-0 overflow-hidden ${d.getMonth() !== anchor.getMonth() ? "opacity-40" : ""}`}>
              <button onClick={() => onDay(d)} className={`text-xs mb-1 w-8 h-8 md:w-6 md:h-6 rounded-full ${sameDay(d, today) ? "bg-gold text-black font-semibold" : "hover:bg-wash-2"}`}>
                {d.getDate()}
              </button>
              <div className="space-y-0.5">
                {list.slice(0, 3).map((e) => (
                  <button key={e.id + e.start} onClick={() => onPick(e)} className="flex items-center gap-1 w-full text-left text-[11px] truncate hover:bg-wash-2 rounded px-1">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color(e.account) }} />
                    {!e.allDay && <span className="text-muted hidden sm:inline">{fmtTime(parseWhen(e.start))}</span>}
                    <span className="truncate hidden sm:inline">{e.summary}</span>
                  </button>
                ))}
                {list.length > 3 && <button onClick={() => onDay(d)} className="text-[10px] text-muted px-1">+{list.length - 3} more</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- event panel + form

function EventPanel({ ev, color, onClose, onChanged, onRecord }: { ev: CalEvent; color: string; onClose: () => void; onChanged: () => void; onRecord: () => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const s = parseWhen(ev.start);
  const e = parseWhen(ev.end);

  async function cancel() {
    const notify = ev.attendees.length > 0;
    if (!confirm(`Delete "${ev.summary}" from your calendar?${notify ? ` Its guests (${ev.attendees.join(", ")}) will get a cancellation.` : ""}`)) return;
    setBusy(true);
    const res = await fetch(`/api/calendar?${new URLSearchParams({ id: ev.id, account: ev.account, ...(notify ? { notify: "1" } : {}) })}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) return alert((await res.json()).error);
    onChanged();
  }

  async function prepNotes() {
    setBusy(true);
    const body = `**When:** ${s.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}\n\n${ev.attendees.length ? `**With:** ${ev.attendees.join(", ")}\n\n` : ""}## Goal\n\n\n## Agenda\n\n- \n\n## Notes\n\n\n## Next steps\n\n- [ ] `;
    const res = await fetch("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `Prep: ${ev.summary}`, body, icon: "📝", folder_path: "Meetings" }),
    });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) return alert(d.error);
    router.push(`/files?id=${d.page.id}`);
  }

  if (editing) {
    return (
      <EventForm
        accounts={[ev.account]}
        existing={ev}
        initial={{ summary: ev.summary, description: ev.description, attendees: ev.attendees.join(", "), start: s, end: e, account: ev.account }}
        onClose={() => setEditing(false)}
        onSaved={onChanged}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-40 bg-wash-3 flex items-center justify-center" onClick={onClose}>
      <div className="bg-panel border border-panel-border rounded-xl w-[calc(100vw-2rem)] max-w-[30rem] max-h-[90dvh] overflow-y-auto p-5 shadow-2xl" onClick={(x) => x.stopPropagation()} data-testid="event-panel">
        <div className="flex items-start gap-3">
          <span className="w-3 h-3 rounded mt-1.5 shrink-0" style={{ background: color }} />
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold">{ev.summary}</h2>
            <div className="text-sm text-muted mt-1">
              {ev.allDay
                ? s.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
                : `${s.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} · ${fmtTime(s)} – ${fmtTime(e)}`}
            </div>
            <div className="text-xs text-muted mt-1">{ev.account}{ev.recurring ? " · repeats" : ""}</div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-foreground" aria-label="Close">✕</button>
        </div>
        {ev.attendees.length > 0 && (
          <div className="mt-4 text-sm">
            <div className="text-xs text-muted mb-1">Guests</div>
            {ev.attendees.map((a) => <div key={a}>{a}</div>)}
          </div>
        )}
        {ev.description && <div className="mt-4 text-sm whitespace-pre-wrap text-foreground/80 max-h-48 overflow-y-auto">{ev.description}</div>}
        <div className="mt-5 flex flex-wrap gap-2">
          <button onClick={onRecord} className="text-xs bg-red-500 text-white font-semibold rounded px-3 py-1.5 hover:bg-red-600">● Record meeting</button>
          <button onClick={prepNotes} disabled={busy} className="text-xs border border-panel-border rounded px-3 py-1.5 hover:border-gold">📝 Prep notes</button>
          {!ev.recurring && <button onClick={() => setEditing(true)} className="text-xs border border-panel-border rounded px-3 py-1.5 hover:border-gold">Edit</button>}
          {ev.htmlLink && <a href={ev.htmlLink} target="_blank" rel="noreferrer" className="text-xs border border-panel-border rounded px-3 py-1.5 hover:border-gold">Open in Google</a>}
          {!ev.recurring && <button onClick={cancel} disabled={busy} className="text-xs text-danger hover:underline ml-auto">Delete</button>}
        </div>
      </div>
    </div>
  );
}

function EventForm({
  accounts,
  initial,
  existing,
  onClose,
  onSaved,
}: {
  accounts: string[];
  initial: { summary: string; description: string; attendees: string; start: Date; end: Date; account: string };
  existing?: CalEvent;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({ ...initial, start: initial.start.toISOString(), end: initial.end.toISOString() });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function onStartChange(iso: string) {
    const os = new Date(f.start).getTime();
    const oe = new Date(f.end).getTime();
    const end = oe > os ? addMinutesIso(iso, Math.round((oe - os) / 60000)) : addMinutesIso(iso, 60);
    setF({ ...f, start: iso, end });
  }

  async function save() {
    const start = new Date(f.start);
    const end = new Date(f.end);
    if (!f.summary.trim()) return setErr("Give it a title.");
    if (!(end > start)) return setErr("The end has to be after the start.");
    const attendees = f.attendees.split(/[,\s]+/).map((a) => a.trim()).filter((a) => a.includes("@"));
    if (attendees.length && !existing && !confirm(`Send an invite to ${attendees.join(", ")}?`)) return;
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/calendar", {
      method: existing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(existing ? { id: existing.id, notify: attendees.length > 0 } : {}),
        account: f.account,
        summary: f.summary.trim(),
        description: f.description,
        start: start.toISOString(),
        end: end.toISOString(),
        attendees,
      }),
    });
    setBusy(false);
    if (!res.ok) return setErr((await res.json()).error || "Couldn't save.");
    onSaved();
  }

  const input = "w-full bg-background border border-panel-border rounded px-3 py-2 text-sm outline-none focus:border-gold";
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-panel border border-panel-border rounded-xl w-[calc(100vw-2rem)] max-w-[30rem] max-h-[90dvh] overflow-y-auto p-5 space-y-3 shadow-2xl" onClick={(x) => x.stopPropagation()} data-testid="event-form">
        <div className="text-sm font-semibold">{existing ? "Edit event" : "New event"}</div>
        <input autoFocus value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} placeholder="Title" className={input} />
        <div className="space-y-2">
          <CentralDateTimeInput label="Start" testId="event-start" value={f.start} onChange={onStartChange} />
          <CentralDateTimeInput label="End" testId="event-end" value={f.end} onChange={(iso) => setF({ ...f, end: iso })} />
        </div>
        <input value={f.attendees} onChange={(e) => setF({ ...f, attendees: e.target.value })} placeholder="Guests (emails, comma separated)" className={input} />
        <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Description" rows={3} className={input} />
        {!existing && accounts.length > 1 && (
          <select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} className={input}>
            {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        {err && <div className="text-xs text-danger">{err}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-xs border border-panel-border rounded px-3 py-1.5 hover:border-gold">Cancel</button>
          <button onClick={save} disabled={busy} className="text-xs bg-gold text-black font-semibold rounded px-4 py-1.5 hover:bg-gold-soft disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
