"use client";
import { useOwnerName } from "../CellContext";
// Execution board: the real-world steps that make canon real. Proposed → Approved → Done.
// Approving hands a step to Tasks / Communications (an email DRAFT) / the approval queue (a calendar request).
import { useCallback, useEffect, useState } from "react";

type Step = {
  id: number; kind: "task" | "email" | "meeting" | "manual"; title: string; details: string;
  payload: Record<string, unknown> | null; status: "proposed" | "approved" | "done" | "declined" | "failed";
  result: string | null; created_by: string; created_at: string;
};

const KIND: Record<Step["kind"], { icon: string; label: string; hint: string }> = {
  task: { icon: "✅", label: "Task", hint: "Goes to your Tasks list" },
  email: { icon: "✉️", label: "Email", hint: "Becomes a draft in Communications. You still press send." },
  meeting: { icon: "📅", label: "Meeting", hint: "Becomes a calendar request in your approval queue. No invite until you approve it there." },
  manual: { icon: "🤝", label: "By hand", hint: "A call, visit or anything you do yourself" },
};

const COLUMNS: { key: string; title: string; match: Step["status"][] }[] = [
  { key: "proposed", title: "Proposed", match: ["proposed", "failed"] },
  { key: "approved", title: "In motion", match: ["approved"] },
  { key: "done", title: "Done", match: ["done"] },
];

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d as T;
}

function fmtWhen(iso: unknown) {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) + " CT";
}

function StepCard({ s, isOwner, apiBase, onChange }: { s: Step; isOwner: boolean; apiBase: string; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (action: string) => {
    setBusy(true);
    setErr("");
    try {
      await call(`${apiBase}/steps/${s.id}`, { action });
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  const p = s.payload ?? {};
  return (
    <li className="rounded-xl border border-panel-border bg-panel p-3 flex flex-col gap-2" data-testid={`step-${s.id}`}>
      <button className="flex items-start gap-2 text-left" onClick={() => setOpen((v) => !v)}>
        <span aria-hidden>{KIND[s.kind].icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block font-medium leading-snug">{s.title}</span>
          <span className="block text-xs text-muted mt-0.5">
            {KIND[s.kind].label}
            {s.kind === "email" && ` · to ${String(p.to)}`}
            {s.kind === "meeting" && ` · ${fmtWhen(p.start)}`}
            {s.kind === "task" && p.due_date ? ` · due ${String(p.due_date)}` : ""}
            {" · "}by {s.created_by.replace(/^agent:/, "🤖 ")}
          </span>
        </span>
        {s.status === "failed" && <span className="text-[10px] uppercase text-danger border border-danger rounded px-1">failed</span>}
      </button>
      {open && (
        <div className="text-sm flex flex-col gap-2">
          {s.details && <p className="whitespace-pre-wrap text-foreground/90">{s.details}</p>}
          {s.kind === "email" && (
            <div className="rounded-lg bg-wash-1 p-2 text-xs whitespace-pre-wrap"><b>Subject:</b> {String(p.subject)}{"\n\n"}{String(p.body)}</div>
          )}
          {s.kind === "meeting" && (
            <div className="text-xs text-muted">{fmtWhen(p.start)} → {fmtWhen(p.end)}{Array.isArray(p.attendees) && p.attendees.length ? ` · with ${p.attendees.join(", ")}` : ""}</div>
          )}
          <p className="text-[11px] text-muted">{KIND[s.kind].hint}</p>
        </div>
      )}
      {s.result && <p className={`text-xs ${s.status === "failed" ? "text-danger" : "text-muted"}`} data-testid="step-result">{s.result}</p>}
      {err && <p className="text-xs text-danger" role="alert">{err}</p>}
      {isOwner && (s.status === "proposed" || s.status === "failed") && (
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} onClick={() => act("approve")} data-testid="step-approve" className="px-3 py-1.5 text-sm rounded-lg bg-accent text-background disabled:opacity-50">
            {s.status === "failed" ? "Try again" : "Approve"}
          </button>
          <button disabled={busy} onClick={() => act("decline")} data-testid="step-decline" className="px-3 py-1.5 text-sm rounded-lg border border-panel-border">Decline</button>
        </div>
      )}
      {isOwner && s.status === "approved" && (
        <div><button disabled={busy} onClick={() => act("done")} data-testid="step-done" className="px-3 py-1.5 text-sm rounded-lg border border-panel-border">Mark done</button></div>
      )}
    </li>
  );
}

function AddStep({ apiBase, slug, onAdded }: { apiBase: string; slug: string; onAdded: () => void }) {
  const [kind, setKind] = useState<Step["kind"]>("task");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [f, setF] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const field = "w-full text-sm bg-transparent border border-panel-border rounded-lg px-3 py-2";
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    const payload =
      kind === "email" ? { to: f.to, subject: f.subject, body: f.body }
      : kind === "meeting" ? { start: f.start ? new Date(f.start).toISOString() : "", end: f.end ? new Date(f.end).toISOString() : "", attendees: f.attendees }
      : kind === "task" ? { due_date: f.due || undefined }
      : undefined;
    try {
      await call(`${apiBase}/${slug}/steps`, { kind, title, details, payload });
      setTitle(""); setDetails(""); setF({});
      onAdded();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  return (
    <form onSubmit={submit} className="rounded-xl border border-dashed border-panel-border p-3 flex flex-col gap-2" data-testid="step-form">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kind of step">
        {(Object.keys(KIND) as Step["kind"][]).map((k) => (
          <button type="button" key={k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)} data-testid={`step-kind-${k}`}
            className={`px-3 py-1.5 text-sm rounded-full border ${kind === k ? "border-gold bg-gold-soft text-foreground" : "border-panel-border text-muted"}`}>
            {KIND[k].icon} {KIND[k].label}
          </button>
        ))}
      </div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="What's the step?" className={field} data-testid="step-title" />
      {kind === "email" && (
        <>
          <input value={f.to ?? ""} onChange={set("to")} required type="email" placeholder="To (email)" className={field} data-testid="step-to" />
          <input value={f.subject ?? ""} onChange={set("subject")} required placeholder="Subject" className={field} data-testid="step-subject" />
          <textarea value={f.body ?? ""} onChange={set("body")} required placeholder="Email body" className={`${field} min-h-28`} data-testid="step-body" />
        </>
      )}
      {kind === "meeting" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-muted flex flex-col gap-1">Starts<input type="datetime-local" value={f.start ?? ""} onChange={set("start")} required className={field} /></label>
          <label className="text-xs text-muted flex flex-col gap-1">Ends<input type="datetime-local" value={f.end ?? ""} onChange={set("end")} required className={field} /></label>
          <input value={f.attendees ?? ""} onChange={set("attendees")} placeholder="Guests' emails, comma-separated (optional)" className={`${field} sm:col-span-2`} />
        </div>
      )}
      {kind === "task" && <label className="text-xs text-muted flex flex-col gap-1">Due (optional)<input type="date" value={f.due ?? ""} onChange={set("due")} className={field} /></label>}
      <textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={8000} placeholder="Why, and any details (optional)" className={`${field} min-h-16`} />
      <p className="text-[11px] text-muted">{`${KIND[kind].hint}. Nothing happens until it's approved.`}</p>
      {err && <p className="text-xs text-danger" role="alert">{err}</p>}
      <div><button className="px-4 py-2 text-sm rounded-lg bg-accent text-background" data-testid="step-submit">Propose step</button></div>
    </form>
  );
}

export default function ExecutionBoard({ slug, apiBase, isOwner, canPropose }: { slug: string; apiBase: string; isOwner: boolean; canPropose: boolean }) {
  const ownerName = useOwnerName();
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => call<{ steps: Step[] }>(`${apiBase}/${slug}/steps`).then((d) => setSteps(d.steps)).catch((e) => setError(e.message)), [apiBase, slug]);
  useEffect(() => {
    call<{ steps: Step[] }>(`${apiBase}/${slug}/steps`).then((d) => setSteps(d.steps)).catch((e) => setError(e.message));
  }, [apiBase, slug]);
  const declined = steps?.filter((s) => s.status === "declined") ?? [];

  return (
    <div className="flex flex-col gap-5" data-testid="execution-board">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-xl md:text-2xl font-bold">Execution</h2>
          <p className="text-sm text-muted mt-1">
            The real-world steps that make this real. Nothing happens until {isOwner ? "you approve" : `${ownerName} approves`} a step, and then it goes where that kind of work already lives: Tasks, an email draft in Communications, or a calendar request in the approval queue. Send the Producer agent to draft a plan.
          </p>
        </div>
        {canPropose && (
          <button onClick={() => setAdding((v) => !v)} data-testid="step-add" className="px-3 py-2 text-sm rounded-lg border border-panel-border">{adding ? "Close" : "+ Add a step"}</button>
        )}
      </div>
      {adding && canPropose && <AddStep apiBase={apiBase} slug={slug} onAdded={() => { setAdding(false); load(); }} />}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {!steps && !error && <p className="text-sm text-muted">Loading…</p>}
      {steps && steps.length === 0 && (
        <p className="text-sm text-muted rounded-xl border border-panel-border p-4">No steps yet. Add one, or send the Producer agent (Agents panel) to draft a plan from canon.</p>
      )}
      {steps && steps.length > 0 && (
        <div className="grid gap-4 md:grid-cols-3">
          {COLUMNS.map((col) => {
            const list = steps.filter((s) => col.match.includes(s.status));
            return (
              <section key={col.key} data-testid={`exec-col-${col.key}`} className="flex flex-col gap-2 min-w-0">
                <h3 className="text-xs uppercase tracking-wide text-muted">{col.title} · {list.length}</h3>
                <ul className="flex flex-col gap-2">
                  {list.map((s) => <StepCard key={s.id} s={s} isOwner={isOwner} apiBase={apiBase} onChange={load} />)}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {declined.length > 0 && <p className="text-xs text-muted">{declined.length} declined step{declined.length === 1 ? "" : "s"} kept in history.</p>}
    </div>
  );
}
