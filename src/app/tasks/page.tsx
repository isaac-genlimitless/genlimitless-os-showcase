"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { setOsContext } from "@/lib/os-context";
import TaskDeleteButton from "@/components/TaskDeleteButton";
import LikelyDoneSection from "@/components/LikelyDoneSection";

type Task = {
  id: number;
  title: string;
  notes: string | null;
  category: string | null;
  status: "open" | "done";
  priority: "low" | "normal" | "high";
  due_date: string | null;
  completed_at: string | null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PRIORITY_LABEL = { low: "Low", normal: "Normal", high: "High" } as const;

function fmtDue(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return `${MONTHS[m - 1]} ${day}${y !== new Date().getFullYear() ? `, ${y}` : ""}`;
}

/** Today's Central calendar date as YYYY-MM-DD (en-CA formats as ISO). */
function todayCentral(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

const inputCls = "bg-background border border-panel-border rounded px-2 py-1 text-sm focus:outline-none focus:border-accent max-w-full max-md:w-full";

export default function TasksPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted">Loading…</div>}>
      <TasksInner />
    </Suspense>
  );
}

function TasksInner() {
  // /tasks?id=N (an @ mention link): show that task, scroll to it and highlight it for a few seconds.
  const params = useSearchParams();
  const focusId = Number(params.get("id")) || null;
  const handledFocus = useRef<number | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("");
  const [showDone, setShowDone] = useState(true);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState({ title: "", notes: "", category: "", priority: "normal", due_date: "" });
  const [add, setAdd] = useState({ title: "", category: "", priority: "normal", due_date: "" });
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?status=all", { cache: "no-store" });
      const d = await r.json();
      setTasks(d.tasks || []);
    } catch {
      setError("Couldn't load tasks.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!focusId || !tasks || handledFocus.current === focusId) return;
    if (!tasks.some((t) => t.id === focusId)) return;
    handledFocus.current = focusId;
    setShowDone(true);
    setCategory("");
    setHighlight(focusId);
    const raf = setTimeout(() => document.querySelector(`[data-task-id="${focusId}"]`)?.scrollIntoView?.({ block: "center" }), 50);
    const off = setTimeout(() => setHighlight((h) => (h === focusId ? null : h)), 3000);
    return () => {
      clearTimeout(raf);
      clearTimeout(off);
    };
  }, [focusId, tasks]);

  const openCount =(tasks || []).filter((t) => t.status === "open").length;
  useEffect(() => {
    setOsContext(`${openCount} open tasks`, "tasks");
    return () => setOsContext(null, "tasks");
  }, [openCount]);

  async function send(url: string, method: string, body: unknown): Promise<boolean> {
    setError(null);
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setError(d.error || `Request failed (${r.status})`);
      return false;
    }
    await load();
    return true;
  }

  async function addTask(e: React.FormEvent) {
    e.preventDefault();
    if (!add.title.trim()) return;
    const ok = await send("/api/tasks", "POST", {
      title: add.title,
      category: add.category || null,
      priority: add.priority,
      due_date: add.due_date || null,
    });
    if (ok) setAdd({ title: "", category: "", priority: add.priority, due_date: "" });
  }

  function startEdit(t: Task) {
    setEditing(t.id);
    setDraft({ title: t.title, notes: t.notes || "", category: t.category || "", priority: t.priority, due_date: t.due_date || "" });
  }

  async function saveEdit(id: number) {
    const ok = await send(`/api/tasks/${id}`, "PATCH", {
      title: draft.title,
      notes: draft.notes || null,
      category: draft.category || null,
      priority: draft.priority,
      due_date: draft.due_date || null,
    });
    if (ok) setEditing(null);
  }

  const all = tasks || [];
  const categories = Array.from(new Set(all.map((t) => t.category).filter((c): c is string => !!c))).sort();
  const visible = all.filter((t) => !category || t.category === category);
  const open = visible.filter((t) => t.status === "open");
  const done = visible.filter((t) => t.status === "done");
  const today = todayCentral();

  function row(t: Task) {
    const isEditing = editing === t.id;
    const overdue = t.status === "open" && !!t.due_date && t.due_date < today;
    return (
      <li
        key={t.id}
        data-testid="task-row"
        data-task-id={t.id}
        data-highlighted={highlight === t.id ? "true" : undefined}
        className={`flex flex-wrap md:flex-nowrap items-start gap-3 max-md:gap-y-2 px-4 py-3 bg-panel border border-panel-border rounded transition-shadow ${highlight === t.id ? "ring-2 ring-accent" : ""}`}
      >
        <label className="flex items-center justify-center shrink-0 max-md:w-11 max-md:h-11 max-md:-m-2.5">
          <input
            type="checkbox"
            className="mt-1 accent-accent max-md:mt-0 max-md:w-5 max-md:h-5"
            checked={t.status === "done"}
            aria-label={t.status === "done" ? "Reopen" : "Mark done"}
            onChange={() => send(`/api/tasks/${t.id}`, "PATCH", { status: t.status === "done" ? "open" : "done" })}
          />
        </label>
        {isEditing ? (
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex flex-wrap gap-2">
              <input className={`${inputCls} flex-1 min-w-48`} aria-label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              <input className={inputCls} aria-label="Category" placeholder="Category" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
              <select className={inputCls} aria-label="Priority" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
              <input type="date" className={inputCls} aria-label="Due date" value={draft.due_date} onChange={(e) => setDraft({ ...draft, due_date: e.target.value })} />
            </div>
            <textarea className={`${inputCls} w-full`} aria-label="Notes" placeholder="Notes" rows={2} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
            <div className="flex gap-2">
              <button className="px-3 py-1 text-sm rounded bg-accent text-black max-md:flex-1" onClick={() => saveEdit(t.id)}>
                Save
              </button>
              <button className="px-3 py-1 text-sm rounded border border-panel-border text-muted max-md:flex-1" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 min-w-0">
              <div className={`text-base md:text-sm [overflow-wrap:anywhere] ${t.status === "done" ? "line-through text-muted" : ""}`}>{t.title}</div>
              {t.notes && <div className="text-sm md:text-xs text-muted mt-1 whitespace-pre-wrap">{t.notes}</div>}
            </div>
            <div className="flex flex-wrap items-center gap-2 max-md:order-last max-md:basis-full max-md:pl-9 md:contents">
              {t.category && <span className="text-xs max-md:text-[13px] px-2 py-0.5 max-md:py-1 rounded-full border border-panel-border text-muted">{t.category}</span>}
              <span className={`text-xs max-md:text-[13px] px-2 py-0.5 max-md:py-1 rounded ${t.priority === "high" ? "bg-accent text-black font-semibold" : "border border-panel-border text-muted"}`}>
                {PRIORITY_LABEL[t.priority]}
              </span>
              {t.due_date && <span className={`text-xs max-md:text-sm max-md:font-medium ${overdue ? "text-danger" : "text-muted"}`}>{fmtDue(t.due_date)}</span>}
            </div>
            <button className="text-xs text-muted hover:text-foreground max-md:text-sm max-md:px-3 max-md:-my-2.5 max-md:border max-md:border-panel-border max-md:rounded" onClick={() => startEdit(t)}>
              Edit
            </button>
            <TaskDeleteButton id={t.id} title={t.title} onRemoved={load} onError={setError} />
          </>
        )}
      </li>
    );
  }

  return (
    <div className="tasks-page p-8 space-y-8 max-md:space-y-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-display text-2xl tracking-wide">Tasks</h1>
        <button
          data-testid="task-reconcile"
          className="px-3 py-1 text-sm rounded border border-panel-border text-muted hover:text-foreground disabled:opacity-50"
          disabled={checking}
          onClick={async () => {
            setError(null);
            setChecking(true);
            const r = await fetch("/api/tasks/reconcile", { method: "POST" }).catch(() => null);
            if (!r || !r.ok) setError("Couldn't start the check.");
            else setNote("Checking your open tasks against mail, texts and what's built. Chief will post what he closed in chat; refresh in a minute.");
            setChecking(false);
          }}
        >
          {checking ? "Starting…" : "Check for finished tasks"}
        </button>
      </div>
      {note && <div className="text-sm text-muted">{note}</div>}

      <form data-testid="task-add" onSubmit={addTask} className="flex flex-wrap gap-2 items-center">
        <input className={`${inputCls} flex-1 min-w-56`} placeholder="Add a task…" aria-label="Task title" value={add.title} onChange={(e) => setAdd({ ...add, title: e.target.value })} />
        <input className={inputCls} placeholder="Category" aria-label="Category" value={add.category} onChange={(e) => setAdd({ ...add, category: e.target.value })} />
        <select className={inputCls} aria-label="Priority" value={add.priority} onChange={(e) => setAdd({ ...add, priority: e.target.value })}>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </select>
        <input type="date" className={inputCls} aria-label="Due date" value={add.due_date} onChange={(e) => setAdd({ ...add, due_date: e.target.value })} />
        <button type="submit" className="px-3 py-1 text-sm rounded bg-accent text-black max-md:w-full">
          Add task
        </button>
      </form>

      {error && <div className="text-sm text-danger">{error}</div>}

      {tasks === null ? (
        <div className="text-muted text-sm">Loading…</div>
      ) : (
        <>
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {["", ...categories].map((c) => (
                <button
                  key={c || "all"}
                  onClick={() => setCategory(c)}
                  className={`text-xs max-md:text-sm max-md:px-4 px-3 py-1 rounded-full border ${category === c ? "border-accent text-accent" : "border-panel-border text-muted"}`}
                >
                  {c || "All"}
                </button>
              ))}
            </div>
          )}

          {all.length === 0 ? (
            <>
              <LikelyDoneSection onChanged={load} />
              <div className="text-muted text-sm">No tasks yet.</div>
            </>
          ) : (
            <>
              <LikelyDoneSection onChanged={load} />
              <section className="space-y-2">
                <h2 className="text-sm text-muted uppercase tracking-wide">Open ({open.length})</h2>
                <ul className="space-y-2">{open.map(row)}</ul>
              </section>
              <section className="space-y-2">
                <button className="text-sm text-muted uppercase tracking-wide" onClick={() => setShowDone(!showDone)}>
                  {showDone ? "▾" : "▸"} Done ({done.length})
                </button>
                {showDone && <ul className="space-y-2">{done.map(row)}</ul>}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
