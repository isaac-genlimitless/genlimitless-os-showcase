"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { setOsContext } from "@/lib/os-context";
import { useDictation } from "@/components/useDictation";

// TODAY: the home screen that isn't a chat. What's on, what's due, what you promised, what's
// waiting on you, and a capture box to throw anything at Chief without stopping.

type Commitment = { id: number; direction: "owner_owes" | "owed_to_owner"; person: string; what: string; due_date: string | null; status: string };
type Capture = { id: number; text: string; status: string; result: string | null; created_at: string };
type TodayData = {
  date: string;
  priorities: { id: number; title: string }[];
  events: { summary: string; start: string; end: string; allDay?: boolean }[];
  calendar_error: string | null;
  tasks_due: { id: number; title: string; due_date: string; priority: string }[];
  tasks_open: number;
  commitments: { overdue: Commitment[]; due_soon: Commitment[]; mine_open: number; waiting_on: Commitment[]; stale_waiting_on: Commitment[] };
  decisions: { total: number; top: { key: string; title: string; autopilot_send_at?: string }[] };
  autopilot_scheduled: { id: number; kind: string; label: string | null; send_at: string }[];
  captures: Capture[];
};

const card = "bg-panel border border-panel-border rounded p-4 space-y-2";
const inputCls = "bg-background border border-panel-border rounded px-2 py-1 text-sm focus:outline-none focus:border-accent max-md:w-full";

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
const utc = (s: string) => new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");

export default function TodayPage() {
  const [data, setData] = useState<TodayData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [add, setAdd] = useState({ direction: "owner_owes", person: "", what: "", due_date: "" });
  const fileRef = useRef<HTMLInputElement>(null);
  const dict = useDictation(text, setText);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/today", { cache: "no-store" });
      setData(await r.json());
    } catch {
      setError("Couldn't load today.");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!data) return;
    setOsContext(`Today page: ${data.decisions.total} decisions waiting, ${data.tasks_due.length} tasks due, ${data.commitments.overdue.length} overdue promises`, "today");
    return () => setOsContext(null, "today");
  }, [data]);

  async function capture(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() && !files.length) return;
    setSaving(true);
    setError(null);
    const form = new FormData();
    form.set("text", text);
    for (const f of files) form.append("files", f);
    try {
      const r = await fetch("/api/captures", { method: "POST", body: form });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Capture failed (${r.status})`);
      setText("");
      setFiles([]);
      if (fileRef.current) fileRef.current.value = "";
      setNote("Captured. Chief is filing it.");
      setTimeout(() => setNote(null), 4000);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function patchCommitment(id: number, status: "done" | "cancelled") {
    setError(null);
    const r = await fetch("/api/commitments", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status }) });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error || "Couldn't update that promise");
    await load();
  }

  async function addCommitment(e: React.FormEvent) {
    e.preventDefault();
    if (!add.person.trim() || !add.what.trim()) return;
    setError(null);
    const r = await fetch("/api/commitments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...add, due_date: add.due_date || null }),
    });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error || "Couldn't add that promise");
    else setAdd({ ...add, person: "", what: "", due_date: "" });
    await load();
  }

  const c = data?.commitments;
  const mineShown = c ? [...c.overdue, ...c.due_soon] : [];
  const promise = (x: Commitment, overdue: boolean) => (
    <li key={x.id} data-testid="commitment-row" className="flex flex-wrap items-start gap-2 text-sm">
      <span className="flex-1 min-w-0 [overflow-wrap:anywhere]">
        {x.what} <span className="text-muted">· {x.direction === "owner_owes" ? "to" : "from"} {x.person}</span>
        {x.due_date && <span className={`ml-1 text-xs ${overdue ? "text-danger" : "text-muted"}`}>{x.due_date}</span>}
      </span>
      <button className="text-xs px-2 py-0.5 rounded border border-panel-border text-muted hover:text-foreground" onClick={() => patchCommitment(x.id, "done")}>
        Done
      </button>
      <button className="text-xs px-2 py-0.5 rounded border border-panel-border text-muted hover:text-foreground" onClick={() => patchCommitment(x.id, "cancelled")}>
        Drop
      </button>
    </li>
  );

  return (
    <div className="p-8 max-md:p-4 space-y-6">
      <div>
        <h1 className="font-display text-2xl tracking-wide">Today</h1>
        {data && <p className="text-sm text-muted mt-1">{new Date(data.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}</p>}
      </div>

      <form data-testid="capture-box" onSubmit={capture} className={card}>
        <label htmlFor="capture-text" className="text-sm font-semibold">
          Capture
        </label>
        <textarea
          id="capture-text"
          className={`${inputCls} w-full`}
          rows={2}
          placeholder="Anything: a to-do, an idea, a promise, a receipt… Chief files it."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) capture(e);
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={saving || (!text.trim() && !files.length)} className="px-3 py-1.5 text-sm rounded bg-accent text-black disabled:opacity-40">
            {saving ? "Capturing…" : "Capture"}
          </button>
          {dict.supported && (
            <button type="button" aria-label={dict.listening ? "Stop dictation" : "Dictate"} onClick={dict.toggle} className={`px-3 py-1.5 text-sm rounded border ${dict.listening ? "border-accent text-accent" : "border-panel-border text-muted"}`}>
              {dict.listening ? "● Listening" : "🎙 Dictate"}
            </button>
          )}
          <label className="px-3 py-1.5 text-sm rounded border border-panel-border text-muted cursor-pointer">
            {files.length ? `${files.length} file${files.length > 1 ? "s" : ""}` : "Add file"}
            <input ref={fileRef} type="file" multiple className="hidden" aria-label="Attach files" onChange={(e) => setFiles(Array.from(e.target.files || []))} />
          </label>
          {note && <span className="text-sm text-accent">{note}</span>}
          {dict.error && <span className="text-xs text-danger">{dict.error}</span>}
        </div>
      </form>

      {error && <div className="text-sm text-danger" role="alert">{error}</div>}
      {!data ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          <section data-testid="today-needs-you" className={card}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Needs you</h2>
              <Link href="/decisions" className="text-xs text-accent">
                {data.decisions.total} waiting →
              </Link>
            </div>
            {data.decisions.total === 0 ? (
              <div className="text-sm text-muted">Nothing waiting on you.</div>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.decisions.top.map((d) => (
                  <li key={d.key} className="[overflow-wrap:anywhere]">
                    {d.title}
                    {d.autopilot_send_at && <span className="text-xs text-accent"> · Autopilot {time(utc(d.autopilot_send_at).toISOString())}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section data-testid="today-calendar" className={card}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">On the calendar</h2>
              <Link href="/calendar" className="text-xs text-accent">
                Calendar →
              </Link>
            </div>
            {data.calendar_error ? (
              <div className="text-sm text-muted">{data.calendar_error}</div>
            ) : data.events.length === 0 ? (
              <div className="text-sm text-muted">Nothing scheduled.</div>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.events.map((e, i) => (
                  <li key={i}>
                    <span className="text-muted text-xs mr-2">{e.allDay ? "All day" : time(e.start)}</span>
                    {e.summary}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section data-testid="today-promises" className={card}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Promises</h2>
              <span className="text-xs text-muted">{c?.mine_open ?? 0} you owe · {c?.waiting_on.length ?? 0} owed to you</span>
            </div>
            {mineShown.length === 0 && !c?.waiting_on.length && <div className="text-sm text-muted">No open promises due. Chief records them from your mail, texts and meetings.</div>}
            {mineShown.length > 0 && (
              <>
                <div className="text-xs text-muted">You owe (overdue or due in 2 days)</div>
                <ul className="space-y-1">{mineShown.map((x) => promise(x, !!c && c.overdue.some((o) => o.id === x.id)))}</ul>
              </>
            )}
            {!!c?.waiting_on.length && (
              <>
                <div className="text-xs text-muted">Waiting on</div>
                <ul className="space-y-1">{c.waiting_on.slice(0, 8).map((x) => promise(x, c.stale_waiting_on.some((s) => s.id === x.id)))}</ul>
              </>
            )}
            <form data-testid="commitment-add" onSubmit={addCommitment} className="flex flex-wrap gap-2 pt-2">
              <select aria-label="Direction" className={inputCls} value={add.direction} onChange={(e) => setAdd({ ...add, direction: e.target.value })}>
                <option value="owner_owes">I owe</option>
                <option value="owed_to_owner">They owe me</option>
              </select>
              <input aria-label="Person" placeholder="Who" className={`${inputCls} w-28`} value={add.person} onChange={(e) => setAdd({ ...add, person: e.target.value })} />
              <input aria-label="Promise" placeholder="What" className={`${inputCls} flex-1 min-w-32`} value={add.what} onChange={(e) => setAdd({ ...add, what: e.target.value })} />
              <input aria-label="Due" type="date" className={inputCls} value={add.due_date} onChange={(e) => setAdd({ ...add, due_date: e.target.value })} />
              <button type="submit" className="px-3 py-1 text-sm rounded border border-panel-border text-muted">
                Add
              </button>
            </form>
          </section>

          <section data-testid="today-tasks" className={card}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Due</h2>
              <Link href="/tasks" className="text-xs text-accent">
                {data.tasks_open} open →
              </Link>
            </div>
            {data.tasks_due.length === 0 ? (
              <div className="text-sm text-muted">Nothing due today.</div>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.tasks_due.map((t) => (
                  <li key={t.id}>
                    <Link href={`/tasks?id=${t.id}`} className="hover:underline">
                      {t.title}
                    </Link>
                    <span className={`ml-2 text-xs ${t.due_date < data.date ? "text-danger" : "text-muted"}`}>{t.due_date < data.date ? `overdue ${t.due_date}` : "today"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.priorities.length > 0 && (
            <section className={card}>
              <h2 className="text-sm font-semibold">Priorities</h2>
              <ol className="list-decimal pl-5 text-sm space-y-0.5">
                {data.priorities.map((p) => (
                  <li key={p.id}>{p.title}</li>
                ))}
              </ol>
            </section>
          )}

          <section data-testid="today-captures" className={card}>
            <h2 className="text-sm font-semibold">Captured</h2>
            {data.captures.length === 0 ? (
              <div className="text-sm text-muted">Nothing captured yet.</div>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.captures.map((x) => (
                  <li key={x.id} data-testid="capture-row">
                    <div className="[overflow-wrap:anywhere]">{x.text}</div>
                    <div className={`text-xs ${x.status === "failed" ? "text-danger" : "text-muted"}`}>
                      {x.status === "filed" ? `→ ${x.result || "Filed"}` : x.status === "failed" ? x.result || "Couldn't file it" : "Filing…"}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
