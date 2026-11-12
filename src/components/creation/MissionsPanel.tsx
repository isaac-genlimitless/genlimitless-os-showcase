"use client";
// Owner-only: send creation agents on missions (now or tonight), watch the 1M-token daily cap, read reports.
// Agents work only in their own sandboxes; anything they want in canon comes back as a proposal.
import { useCallback, useEffect, useState } from "react";

type Mission = {
  id: number; role: string; goal: string; status: string; budget_tokens: number; used_tokens: number;
  sandbox_id: number | null; report: string | null; stop_reason: string | null; scheduled_for: string | null; created_at: string;
};
type Budget = { cap: number; spent24h: number; reserved: number; remaining: number };
type Role = { key: string; label: string; charter: string };

/** UTC "YYYY-MM-DD HH:MM:SS" → e.g. "Thu 1:00 AM" in Central time. */
const central = (utc: string) =>
  new Date(utc.replace(" ", "T") + "Z").toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit" }) + " CT";
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

export default function MissionsPanel({ slug, apiBase, onOpenSandbox }: { slug: string; apiBase: string; onOpenSandbox: (id: number) => void }) {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState("inventor");
  const [goal, setGoal] = useState("");
  const [tokens, setTokens] = useState(150_000);
  const [when, setWhen] = useState<"now" | "tonight">("tonight");
  const [msg, setMsg] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  const apply = (d: { missions?: Mission[]; budget?: Budget; roles?: Role[] }) => {
    setMissions(d.missions ?? []);
    if (d.budget) setBudget(d.budget);
    if (d.roles) setRoles(d.roles);
  };
  const load = useCallback(() => fetch(`${apiBase}/${slug}/missions`).then((r) => r.json()).then(apply).catch(() => {}), [apiBase, slug]);
  useEffect(() => {
    fetch(`${apiBase}/${slug}/missions`).then((r) => r.json()).then(apply).catch(() => {});
  }, [apiBase, slug]);
  const active = missions.some((m) => m.status === "running" || (m.status === "queued" && !m.scheduled_for));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [active, load]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    const r = await fetch(`${apiBase}/${slug}/missions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role, goal, budget: tokens, when }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setMsg(d.error || "Couldn't start it.");
    setGoal("");
    setMsg(when === "tonight" ? "Queued for 1:00 AM Central." : "Queued. It starts within a few minutes.");
    load();
  }

  async function stop(id: number) {
    const r = await fetch(`${apiBase}/missions/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setMsg(d.error || "Couldn't stop it.");
    load();
  }

  const pct = budget ? Math.min(100, ((budget.spent24h + budget.reserved) / budget.cap) * 100) : 0;
  const charter = roles.find((r) => r.key === role)?.charter;

  return (
    <section className="rounded-xl border border-panel-border bg-panel px-3 py-1 flex flex-col gap-2" data-testid="missions-panel">
      <button className="flex items-center justify-between gap-2 py-1.5 text-xs uppercase tracking-wide text-muted" onClick={() => setOpen((v) => !v)} data-testid="missions-toggle">
        <span>Agents ({missions.filter((m) => m.status === "running" || m.status === "queued").length} active)</span><span aria-hidden className="text-base leading-none">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 pb-3">
          {budget && (
            <div className="text-xs" data-testid="token-budget" title="Hard cap on everything creation agents spend in any rolling 24 hours">
              <div className="flex justify-between text-muted"><span>Daily token cap</span><span className="tabular-nums">{k(budget.spent24h)} used{budget.reserved ? ` + ${k(budget.reserved)} reserved` : ""} of {k(budget.cap)}</span></div>
              <div className="h-2 mt-1 rounded bg-wash-1"><div className="h-2 rounded bg-accent" style={{ width: `${pct}%` }} /></div>
            </div>
          )}
          <form onSubmit={start} className="flex flex-col gap-1.5" data-testid="mission-form">
            <div className="flex flex-wrap gap-1.5">
              <select value={role} onChange={(e) => setRole(e.target.value)} data-testid="mission-role" className="text-sm bg-transparent border border-panel-border rounded-lg px-1 py-1">
                {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
              <select value={when} onChange={(e) => setWhen(e.target.value as "now" | "tonight")} data-testid="mission-when" className="text-sm bg-transparent border border-panel-border rounded-lg px-1 py-1">
                <option value="tonight">Tonight (1 AM)</option>
                <option value="now">Now</option>
              </select>
              <select value={tokens} onChange={(e) => setTokens(Number(e.target.value))} data-testid="mission-budget" className="text-sm bg-transparent border border-panel-border rounded-lg px-1 py-1" title="Most this mission may spend">
                {[50_000, 100_000, 150_000, 250_000, 400_000].map((n) => <option key={n} value={n}>{k(n)} tokens</option>)}
              </select>
            </div>
            {charter && <p className="text-[11px] text-muted">{charter}</p>}
            <textarea value={goal} onChange={(e) => setGoal(e.target.value)} required minLength={10} maxLength={2000} data-testid="mission-goal"
              placeholder="What should it figure out? e.g. Generate 10 physical-site models and rank them by years to pay back."
              className="w-full min-h-16 text-sm bg-transparent border border-panel-border rounded-lg p-2" />
            <div><button className="px-3 py-1 text-sm rounded-lg bg-accent text-background" data-testid="mission-start">Send agent</button></div>
          </form>
          {msg && <p className="text-xs text-muted" role="status" data-testid="mission-msg">{msg}</p>}
          <ul className="flex flex-col gap-2 text-sm" data-testid="mission-list">
            {missions.map((m) => (
              <li key={m.id} className="border-t border-panel-border pt-2" data-testid={`mission-${m.id}`}>
                <div className="flex items-start gap-2">
                  <span className="text-[10px] uppercase border border-panel-border rounded px-1 mt-0.5">{m.status}</span>
                  <button className="flex-1 text-left" onClick={() => setExpanded(expanded === m.id ? null : m.id)}>
                    <b className="capitalize">{m.role}</b>: {m.goal.length > 90 ? m.goal.slice(0, 89) + "…" : m.goal}
                  </button>
                </div>
                <div className="text-[11px] text-muted mt-0.5 flex flex-wrap gap-x-2">
                  <span className="tabular-nums">{k(m.used_tokens)} / {k(m.budget_tokens)} tokens</span>
                  {m.status === "queued" && <span>{m.scheduled_for ? `starts ${central(m.scheduled_for)}` : "starting soon"}</span>}
                  {m.sandbox_id && <button className="underline" onClick={() => onOpenSandbox(m.sandbox_id!)}>open its sandbox</button>}
                  {m.status !== "queued" && <a className="underline" href="/activity">run log</a>}
                  {(m.status === "queued" || m.status === "running") && <button className="underline text-danger" onClick={() => stop(m.id)} data-testid="mission-stop">{m.status === "queued" ? "cancel" : "stop"}</button>}
                </div>
                {expanded === m.id && (m.report || m.stop_reason) && (
                  <div className="mt-1 text-xs whitespace-pre-wrap rounded bg-wash-1 p-2">{m.stop_reason ? `(${m.stop_reason})\n\n` : ""}{m.report}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
