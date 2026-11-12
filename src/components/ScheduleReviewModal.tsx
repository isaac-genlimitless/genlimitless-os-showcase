"use client";

import { useEffect, useMemo, useState } from "react";
import { addMinutesIso, fmtCentral, parseStored } from "@/lib/time";
import { CentralDateTimeInput } from "@/components/CentralDateTimeInput";

// A popup that renders a chat fenced block
// (```schedule-review YYYY-MM-DD```) as an interactive review card. Existing calendar events for
// the day are shown read-only (they're already on the calendar — nothing to approve). Each
// proposed block is individually approvable/editable/rejectable; approving is the only thing
// that ever writes to a calendar, and only for that one item.

type ExistingEvent = {
  id: string;
  account: string;
  summary: string;
  start: string;
  end: string;
  allDay?: boolean;
};

type ProposedItem = {
  id: number;
  date: string;
  title: string;
  start: string;
  end: string;
  description: string | null;
  account: string | null;
  reason: string | null;
  status: "proposed" | "approved" | "rejected" | "expired" | "superseded";
  calendar_event_id: string | null;
  calendar_account: string | null;
};

type TimelineRow =
  | { kind: "existing"; key: string; start: string; end: string; event: ExistingEvent }
  | { kind: "proposed"; key: string; start: string; end: string; item: ProposedItem };

function timeLabel(iso: string) {
  const d = parseStored(iso);
  return d ? fmtCentral(d, { weekday: undefined, month: undefined, day: undefined, timeZoneName: undefined }) : iso;
}

export function ScheduleReviewModal({ date, onClose }: { date: string; onClose: () => void }) {
  const [existing, setExisting] = useState<ExistingEvent[]>([]);
  const [proposed, setProposed] = useState<ProposedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDone, setBulkDone] = useState<{ approved: number; failed: boolean } | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/schedule-items?date=${date}`);
      const data = await res.json();
      setExisting(data.existing || []);
      setProposed(data.proposed || []);
      setCalendarError(data.calendarError || null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const timeline: TimelineRow[] = useMemo(() => {
    const rows: TimelineRow[] = [
      ...existing.map((e) => ({ kind: "existing" as const, key: `e-${e.account}-${e.id}`, start: e.start, end: e.end, event: e })),
      ...proposed.map((p) => ({ kind: "proposed" as const, key: `p-${p.id}`, start: p.start, end: p.end, item: p })),
    ];
    return rows.sort((a, b) => a.start.localeCompare(b.start));
  }, [existing, proposed]);

  async function act(id: number, body: Record<string, unknown>): Promise<boolean> {
    setBusyId(id);
    try {
      const res = await fetch("/api/schedule-items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "That didn't work");
        return false;
      }
      setProposed((prev) => prev.map((p) => (p.id === id ? { ...p, ...data } : p)));
      return true;
    } finally {
      setBusyId(null);
    }
  }

  function approve(id: number) {
    act(id, { action: "approve" });
  }
  function reject(id: number) {
    act(id, { action: "reject" });
  }
  function startEdit(p: ProposedItem) {
    setEditingId(p.id);
    setEditTitle(p.title);
    setEditStart(p.start);
    setEditEnd(p.end);
  }
  async function saveEdit(id: number) {
    await act(id, { action: "edit", title: editTitle, start: editStart, end: editEnd });
    setEditingId(null);
  }
  async function approveAll() {
    // Snapshot rows still awaiting a decision. Rejected and already-approved rows are never included.
    const ids = proposed.filter((p) => p.status === "proposed").map((p) => p.id);
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setBulkDone(null);
    let approved = 0;
    let failed = false;
    for (const id of ids) {
      const ok = await act(id, { action: "approve" });
      if (!ok) {
        failed = true;
        break;
      }
      approved++;
    }
    setBulkBusy(false);
    setBulkDone({ approved, failed });
  }

  const proposedCount = proposed.filter((p) => p.status === "proposed").length;
  const approvedCount = proposed.filter((p) => p.status === "approved").length;
  const rejectedCount = proposed.filter((p) => p.status === "rejected").length;

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="fixed inset-0 z-30 flex items-center justify-center p-2 md:p-4 pointer-events-none">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Review schedule"
          data-testid="schedule-review-modal"
          onClick={(e) => e.stopPropagation()}
          className="pointer-events-auto relative bg-panel border border-panel-border rounded-xl w-full max-w-3xl max-h-[90dvh] flex flex-col shadow-2xl"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-panel-border">
            <div>
              <h2 className="font-display text-xl tracking-wide">Today&apos;s schedule — {date}</h2>
              <div className="text-xs text-muted mt-0.5">
                <span data-testid="count-proposed">Proposed {proposedCount}</span> ·{" "}
                <span data-testid="count-approved">Approved {approvedCount}</span> ·{" "}
                <span data-testid="count-rejected">Rejected {rejectedCount}</span>
              </div>
            </div>
            <button onClick={onClose} aria-label="Close" className="text-muted hover:text-gold text-2xl leading-none px-2">
              ×
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5 min-h-0 space-y-2" data-testid="schedule-timeline">
            {loading ? (
              <div className="text-sm text-muted">Loading…</div>
            ) : timeline.length === 0 ? (
              <div className="text-sm text-muted py-12 text-center">Nothing on the calendar or proposed for this day.</div>
            ) : (
              timeline.map((row) =>
                row.kind === "existing" ? (
                  <div key={row.key} data-testid="schedule-existing-row" className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 rounded-lg border border-panel-border bg-black/20 px-4 py-2.5 text-sm">
                    <div className="sm:w-36 sm:shrink-0 text-xs text-muted">
                      {row.event.allDay ? "All day" : `${timeLabel(row.event.start)} – ${timeLabel(row.event.end)}`}
                    </div>
                    <div className="flex-1 truncate">{row.event.summary}</div>
                    <span className="text-[10px] uppercase tracking-wide text-muted shrink-0">On calendar</span>
                  </div>
                ) : (
                  <ProposedRow
                    key={row.key}
                    item={row.item}
                    busy={busyId === row.item.id}
                    isEditing={editingId === row.item.id}
                    editTitle={editTitle}
                    editStart={editStart}
                    editEnd={editEnd}
                    setEditTitle={setEditTitle}
                    setEditStart={setEditStart}
                    setEditEnd={setEditEnd}
                    onStartEdit={() => startEdit(row.item)}
                    onCancelEdit={() => setEditingId(null)}
                    onSaveEdit={() => saveEdit(row.item.id)}
                    onApprove={() => approve(row.item.id)}
                    onReject={() => reject(row.item.id)}
                  />
                )
              )
            )}
          </div>

          {!loading && proposed.length > 0 && (
            <div className="border-t border-panel-border px-5 py-3 flex items-center justify-between gap-3" data-testid="schedule-bulk-bar">
              <div className="text-xs" data-testid="schedule-bulk-status" aria-live="polite">
                {bulkDone &&
                  (bulkDone.failed ? (
                    <span className="text-gold">Approved {bulkDone.approved}; stopped on an error — {proposedCount} still waiting.</span>
                  ) : (
                    <span className="text-emerald-400">Approved {bulkDone.approved} block{bulkDone.approved === 1 ? "" : "s"} — added to the calendar</span>
                  ))}
              </div>
              <button
                data-testid="approve-all-schedule-items"
                onClick={approveAll}
                disabled={proposedCount === 0 || bulkBusy || busyId !== null || editingId !== null}
                className="bg-gold text-black text-xs font-semibold px-3 py-1.5 rounded hover:bg-gold-soft disabled:opacity-50"
              >
                {bulkBusy ? "Approving…" : `Approve all (${proposedCount})`}
              </button>
            </div>
          )}

          {calendarError && (
            <div className="border-t border-panel-border px-5 py-3 text-xs text-gold" data-testid="schedule-calendar-error">
              {calendarError}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ProposedRow({
  item,
  busy,
  isEditing,
  editTitle,
  editStart,
  editEnd,
  setEditTitle,
  setEditStart,
  setEditEnd,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onApprove,
  onReject,
}: {
  item: ProposedItem;
  busy: boolean;
  isEditing: boolean;
  editTitle: string;
  editStart: string;
  editEnd: string;
  setEditTitle: (v: string) => void;
  setEditStart: (v: string) => void;
  setEditEnd: (v: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const s = parseStored(editStart);
  const e = parseStored(editEnd);
  const invalid = !s || !e || e.getTime() <= s.getTime();
  function onStartChange(iso: string) {
    const ns = parseStored(iso);
    if (s && e && ns && e.getTime() > s.getTime()) {
      setEditEnd(addMinutesIso(iso, Math.round((e.getTime() - s.getTime()) / 60000)));
    } else {
      setEditEnd(addMinutesIso(iso, 60));
    }
    setEditStart(iso);
  }
  return (
    <div data-testid="schedule-proposed-row" data-status={item.status} className="rounded-lg border border-gold/40 bg-gold/5 px-4 py-3 text-sm space-y-2">
      {isEditing ? (
        <div className="space-y-2">
          <input
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            className="w-full bg-black/30 border border-panel-border rounded px-2 py-1.5 text-sm"
          />
          <div className="space-y-2">
            <CentralDateTimeInput label="Start" testId="edit-start" value={editStart} onChange={onStartChange} />
            <CentralDateTimeInput label="End" testId="edit-end" value={editEnd} onChange={setEditEnd} />
          </div>
          {invalid && (
            <div className="text-xs text-red-400" data-testid="schedule-edit-error">
              End must be after the start.
            </div>
          )}
          <div className="flex gap-2">
            <button
              data-testid="save-schedule-item"
              onClick={onSaveEdit}
              disabled={busy || invalid || !editTitle.trim()}
              className="bg-gold text-black text-xs font-semibold px-3 py-1.5 rounded hover:bg-gold-soft disabled:opacity-50"
            >
              Save
            </button>
            <button onClick={onCancelEdit} disabled={busy} className="border border-panel-border text-xs px-3 py-1.5 rounded hover:border-gold disabled:opacity-50">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-medium">{item.title}</div>
              <div className="text-xs text-muted mt-0.5">
                {timeLabel(item.start)} – {timeLabel(item.end)}
                {item.account ? ` · ${item.account}` : ""}
              </div>
            </div>
            <span className="text-[10px] uppercase tracking-wide text-gold shrink-0">New hold</span>
          </div>
          {item.reason && <div className="text-xs text-muted">{item.reason}</div>}
          {item.status === "proposed" ? (
            <div className="flex gap-2 pt-1">
              <button
                data-testid="approve-schedule-item"
                onClick={onApprove}
                disabled={busy}
                className="bg-gold text-black text-xs font-semibold px-3 py-1.5 rounded hover:bg-gold-soft disabled:opacity-50"
              >
                Approve
              </button>
              <button
                data-testid="reject-schedule-item"
                onClick={onReject}
                disabled={busy}
                className="border border-panel-border text-xs px-3 py-1.5 rounded hover:border-gold disabled:opacity-50"
              >
                Reject
              </button>
              <button
                data-testid="edit-schedule-item"
                onClick={onStartEdit}
                disabled={busy}
                className="border border-panel-border text-xs px-3 py-1.5 rounded hover:border-gold disabled:opacity-50"
              >
                Edit
              </button>
            </div>
          ) : (
            <div data-testid="schedule-item-status" className={`text-xs ${item.status === "approved" ? "text-emerald-400" : "text-muted"}`}>
              {item.status === "rejected" ? "Rejected" : item.status === "expired" ? "Expired (time passed)" : item.status === "superseded" ? "Superseded" : "Approved — added to the calendar"}
            </div>
          )}
        </>
      )}
    </div>
  );
}
