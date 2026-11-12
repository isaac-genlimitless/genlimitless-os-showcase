"use client";

import { useEffect, useRef, useState } from "react";
import { fmtCentral } from "@/lib/time";
import { setOsContext } from "@/lib/os-context";
import { MODELS } from "@/lib/model-policy";
import { agentName, fmtTokens } from "@/components/LiveWork";

// What the agents are doing: every run's reasoning, messages, tool calls and results,
// delegations, and the tokens / estimated cost it burned. Running runs update live.

type Run = {
  id: number;
  agent_slug: string;
  trigger: string;
  thread: string | null;
  parent_run_id?: number | null;
  model?: string | null;
  effort?: string | null;
  prompt: string | null;
  status: "running" | "done" | "error";
  summary: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  thinking_tokens: number;
  cost_usd: number;
  tool_calls: number;
  turns: number;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
};
type Ev = { id: number; agent_slug: string; kind: string; tool: string | null; content: string | null; is_error: number; at: string };
type Totals = { runs: number; input_tokens: number; output_tokens: number; thinking_tokens: number; tool_calls: number; cost_usd: number };
type Usage = { byAgent: (Totals & { agent_slug: string })[]; byModel?: { model: string; runs: number; cost_usd: number }[]; total: Totals };
const modelLabel = (id: string | null | undefined) => MODELS.find((m) => m.id === id)?.label ?? (id || "");
const modelEffort = (r: { model?: string | null; effort?: string | null }) => (r.model ? [modelLabel(r.model), r.effort].filter(Boolean).join(" · ") : "");

const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const secs = (ms: number | null) => (ms == null ? "" : ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`);
// Stopped/crashed runs never get the SDK's final cost report, so don't show a misleading $0.
const runCost = (r: Run) => (r.status === "error" && !r.cost_usd ? "cost not reported" : money(r.cost_usd));
const allTokens = (r: Run) => r.input_tokens + r.cache_read_tokens + r.cache_write_tokens + r.output_tokens;
const TRIGGER: Record<string, string> = {
  chat: "Chat",
  triage: "Triage",
  briefing: "Morning briefing",
  improvement_review: "Nightly improvement review",
  ops_review: "Daily ops review",
  inbound_email: "Inbound email",
  inbound_texts: "Inbound texts",
  inbound_sweep: "Inbound triage",
  delegated: "Delegated",
};
const triggerName = (t: string) => TRIGGER[t] || t.replace(/_/g, " ");

// Each agent gets a stable accent so delegated work is easy to follow in the timeline.
const AGENT_COLORS: Record<string, string> = { chief_of_staff: "var(--gold)", full_stack_engineer: "var(--success)" };
const agentColor = (slug: string) => AGENT_COLORS[slug] || "var(--muted)";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-panel border border-panel-border rounded-lg p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="font-display text-3xl text-accent mt-1">{value}</div>
      {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/** A tool call's input as short "key: value" pairs instead of raw JSON. */
function ToolInput({ raw }: { raw: string | null }) {
  if (!raw) return null;
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    return <div className="text-xs text-muted break-words">{raw}</div>;
  }
  const entries = Object.entries(obj || {});
  if (!entries.length) return null;
  return (
    <div className="text-xs text-muted mt-1 space-y-0.5">
      {entries.map(([k, v]) => {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        return (
          <div key={k} className="break-words">
            <span className="text-foreground/70">{k}:</span> {s.length > 240 ? `${s.slice(0, 240)}…` : s}
          </div>
        );
      })}
    </div>
  );
}

function EventRow({ e, lead }: { e: Ev; lead: string }) {
  const [open, setOpen] = useState(false);
  const color = agentColor(e.agent_slug);
  const indent = e.agent_slug !== lead;
  const who = <span style={{ color }} className="font-medium">{agentName(e.agent_slug)}</span>;
  let body: React.ReactNode;
  switch (e.kind) {
    case "thinking":
      body = (
        <div>
          <button onClick={() => setOpen(!open)} className="text-xs text-muted hover:text-foreground py-1">
            {who} <span className="italic">thought</span> {open ? "▾" : "▸"}
          </button>
          <div data-testid="event-thinking-text" className={`text-sm italic text-muted whitespace-pre-wrap break-words mt-1${open ? "" : "line-clamp-2"}`}>{e.content}</div>
        </div>
      );
      break;
    case "text":
      body = (
        <div>
          <div className="text-xs text-muted">{who} said</div>
          <div data-testid="event-text-body" className="text-sm whitespace-pre-wrap break-words mt-1">{e.content}</div>
        </div>
      );
      break;
    case "tool_call":
      body = (
        <div>
          <div className="text-xs text-muted">
            {who} used <span className="font-mono text-foreground bg-wash-2 rounded px-1.5 py-0.5">{e.tool}</span>
          </div>
          <ToolInput raw={e.content} />
        </div>
      );
      break;
    case "tool_result":
      body = (
        <div>
          <button onClick={() => setOpen(!open)} className={`text-xs ${e.is_error ? "text-danger" : "text-muted"} hover:text-foreground py-1`}>
            {e.is_error ? "✗" : "↳"} {e.tool} {e.is_error ? "failed" : "returned"} {open ? "▾" : "▸"}
          </button>
          {open && <div className="text-xs font-mono whitespace-pre-wrap break-words bg-wash-2 rounded p-2 mt-1 max-h-80 overflow-y-auto">{e.content}</div>}
        </div>
      );
      break;
    case "delegate":
      body = (
        <div className="rounded border border-panel-border bg-wash-1 p-2 min-w-0">
          <div className="text-xs">
            {who} handed work to{" "}
            <span style={{ color: agentColor(e.tool || "") }} className="font-semibold">
              {agentName(e.tool || "")}
            </span>
          </div>
          <div className={`text-sm whitespace-pre-wrap break-words mt-1 ${open ? "" : "line-clamp-3"}`}>{e.content}</div>
          {(e.content?.length || 0) > 200 && (
            <button onClick={() => setOpen(!open)} className="text-xs text-accent mt-1 py-1.5">
              {open ? "Less" : "Full brief"}
            </button>
          )}
        </div>
      );
      break;
    default:
      body = <div className="text-sm text-danger whitespace-pre-wrap break-words">{e.content}</div>;
  }
  return (
    <div className={`border-l-2 pl-3 py-1.5 ${indent ? "ml-6" : ""}`} style={{ borderColor: color }} data-testid={`event-${e.kind}`}>
      <div className="flex justify-between gap-3">
        <div className="min-w-0 flex-1">{body}</div>
        <span className="text-[10px] text-muted shrink-0">{fmtCentral(e.at, { weekday: undefined, month: undefined, day: undefined, timeZoneName: undefined })}</span>
      </div>
    </div>
  );
}

function RunDetail({ id, onOpen }: { id: number; onOpen: (id: number) => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [handoffs, setHandoffs] = useState<Run[]>([]);
  const [job, setJob] = useState<{ runs: number; tokens_in: number; tokens_out: number; tool_calls: number; cost_usd: number } | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const lastId = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    lastId.current = 0;
    setEvents([]);
    setRun(null);
    const load = async () => {
      const d = await fetch(`/api/runs?id=${id}&after=${lastId.current}`).then((r) => r.json()).catch(() => null);
      if (stop || !d?.run) return;
      setRun(d.run);
      setHandoffs(d.handoffs || []);
      setJob(d.job || null);
      if (d.events.length) {
        lastId.current = d.events[d.events.length - 1].id;
        setEvents((cur) => [...cur, ...d.events]);
      }
      if (d.run.status === "running") setTimeout(load, 2000);
    };
    load();
    return () => {
      stop = true;
    };
  }, [id]);

  useEffect(() => {
    if (run?.status === "running") bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length, run?.status]);

  if (!run) return <div className="p-6 text-sm text-muted">Loading…</div>;
  const toolCounts = events.filter((e) => e.kind === "tool_call").reduce<Record<string, number>>((m, e) => ((m[e.tool || "?"] = (m[e.tool || "?"] || 0) + 1), m), {});

  return (
    <div className="p-4 md:p-6 space-y-5" data-testid="run-detail">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="w-2 h-2 rounded-full" style={{ background: agentColor(run.agent_slug) }} />
          <h2 className="font-display text-2xl tracking-wide">{agentName(run.agent_slug)}</h2>
          <span className="text-sm text-muted">· {triggerName(run.trigger)}</span>
          {run.status === "running" && (
            <>
              <span className="text-xs text-accent animate-pulse ml-2">● live</span>
              <button
                onClick={async () => {
                  if (!confirm("Stop this run now? Anything it handed off stops too.")) return;
                  await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: run.id }) });
                }}
                data-testid="stop-run"
                className="ml-auto text-xs border border-danger/50 text-danger rounded px-3 py-1 hover:bg-danger/10"
              >
                ■ Stop
              </button>
            </>
          )}
          {run.status === "error" && <span className="text-xs text-danger ml-2">stopped with an error</span>}
        </div>
        {run.parent_run_id && (
          <button onClick={() => onOpen(run.parent_run_id!)} className="text-xs text-accent hover:underline mt-1">
            ← Handed off from run #{run.parent_run_id}
          </button>
        )}
        <div className="text-xs text-muted mt-1">
          Started {fmtCentral(run.started_at)}
          {run.duration_ms != null && ` · took ${secs(run.duration_ms)}`}
          {run.turns ? ` · ${run.turns} turns` : ""}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
        {[
          ["Tokens read", fmtTokens(run.input_tokens + run.cache_read_tokens + run.cache_write_tokens), `${fmtTokens(run.cache_read_tokens)} from cache`],
          ["Tokens written", fmtTokens(run.output_tokens), run.thinking_tokens ? `${fmtTokens(run.thinking_tokens)} thinking` : ""],
          ["Tool calls", String(run.tool_calls), Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t, n]) => `${t} ×${n}`).join(", ")],
          ["Est. cost", run.status === "running" ? "…" : runCost(run), run.status === "running" ? "final when done" : ""],
          ["Status", run.status === "running" ? "Working" : run.status === "done" ? "Done" : "Error", ""],
        ].map(([label, value, sub]) => (
          <div key={label} className="bg-wash-1 border border-panel-border rounded p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
            <div className="text-lg font-semibold mt-0.5">{value}</div>
            {sub && <div className="text-[11px] text-muted truncate">{sub}</div>}
          </div>
        ))}
      </div>

      {handoffs.length > 0 && job && (
        <div className="bg-wash-1 border border-panel-border rounded p-3 text-sm" data-testid="handoffs">
          <div className="text-xs uppercase tracking-wide text-muted mb-2">
            Whole job, including {handoffs.length} hand-off{handoffs.length === 1 ? "" : "s"}: {fmtTokens((job.tokens_in || 0) + (job.tokens_out || 0))} tokens ·{" "}
            {job.tool_calls} tool calls · {money(job.cost_usd || 0)}
          </div>
          {handoffs.map((h) => (
            <button key={h.id} onClick={() => onOpen(h.id)} className="block w-full text-left hover:text-accent py-0.5">
              <span style={{ color: agentColor(h.agent_slug) }}>{agentName(h.agent_slug)}</span> · run #{h.id} ·{" "}
              {h.status === "running" ? "working…" : `${fmtTokens(allTokens(h))} tokens · ${h.tool_calls} tools · ${runCost(h)}`} →
            </button>
          ))}
        </div>
      )}

      {run.prompt && (
        <div>
          <div className="text-xs uppercase tracking-wide text-muted mb-1">Asked</div>
          <div className="text-sm whitespace-pre-wrap break-words bg-wash-1 rounded p-3 max-h-40 overflow-y-auto">{run.prompt}</div>
        </div>
      )}

      <div>
        <div className="text-xs uppercase tracking-wide text-muted mb-2">Step by step</div>
        <div className="space-y-1.5">
          {events.map((e) => (
            <EventRow key={e.id} e={e} lead={run.agent_slug} />
          ))}
          {events.length === 0 && <div className="text-sm text-muted">No steps recorded yet.</div>}
        </div>
        <div ref={bottom} />
      </div>

      {run.status !== "running" && run.summary && (
        <div>
          <div className="text-xs uppercase tracking-wide text-muted mb-1">Final answer</div>
          <div className="text-sm whitespace-pre-wrap break-words bg-panel border border-panel-border rounded p-3">{run.summary}</div>
        </div>
      )}
    </div>
  );
}

export default function ActivityView() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [today, setToday] = useState<Usage | null>(null);
  const [week, setWeek] = useState<Usage | null>(null);
  const [agent, setAgent] = useState<string>("");
  const [selected, setSelected] = useState<number | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const p = Number(new URLSearchParams(window.location.search).get("run"));
    if (p) setSelected(p);
  }, []);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      const d = await fetch(`/api/runs${agent ? `?agent=${agent}` : ""}`).then((r) => r.json()).catch(() => null);
      if (stop || !d) return;
      setRuns(d.runs);
      setToday(d.today);
      setWeek(d.week);
      setSelected((cur) => cur ?? d.runs[0]?.id ?? null);
    };
    load();
    const t = setInterval(() => !document.hidden && load(), 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [agent]);

  // Tell the chat which run is open (ids only).
  useEffect(() => {
    setOsContext(selected !== null ? `run #${selected}, agent filter ${agent || "all agents"}` : null, "activity");
    return () => setOsContext(null, "activity");
  }, [selected, agent]);

  const tok = (t?: Totals) => (t ? fmtTokens(t.input_tokens + t.output_tokens) : "…");

  return (
    <div className="flex flex-col flex-1 md:min-h-0">
      <div className="px-4 md:px-8 pt-6 pb-4 border-b border-panel-border space-y-4">
        <div>
          <h1 className="font-display text-3xl tracking-wide">Activity</h1>
          <p className="text-sm text-muted mt-1">What your agents are doing: their reasoning, every tool they use, who they hand work to, and what it costs. Costs are estimates.</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Tokens, last 24h" value={tok(today?.total)} sub={today ? `${today.total.runs} runs · ${today.total.tool_calls} tool calls` : ""} />
          <Stat label="Est. cost, last 24h" value={today ? money(today.total.cost_usd) : "…"} />
          <Stat label="Tokens, 7 days" value={tok(week?.total)} sub={week ? `${week.total.runs} runs` : ""} />
          <Stat label="Est. cost, 7 days" value={week ? money(week.total.cost_usd) : "…"} />
        </div>
        {week?.byModel && week.byModel.length > 0 && (
          <div className="text-xs text-muted" data-testid="cost-by-model">
            Cost by model (7d): {week.byModel.map((m) => `${modelLabel(m.model === "unknown" ? "" : m.model) || "Not recorded"} ${money(m.cost_usd || 0)}`).join(" · ")}
          </div>
        )}
        {week && week.byAgent.length > 0 && (
          <div className="flex flex-wrap gap-2 text-xs" data-testid="agent-filter">
            <button onClick={() => setAgent("")} className={`px-2.5 py-1 rounded-full border ${agent === "" ? "bg-gold text-black border-gold font-semibold" : "border-panel-border text-muted hover:text-foreground"}`}>
              All agents
            </button>
            {week.byAgent.map((a) => (
              <button
                key={a.agent_slug}
                onClick={() => setAgent(a.agent_slug)}
                className={`px-2.5 py-1 rounded-full border ${agent === a.agent_slug ? "bg-gold text-black border-gold font-semibold" : "border-panel-border text-muted hover:text-foreground"}`}
              >
                {agentName(a.agent_slug)} · {fmtTokens(a.input_tokens + a.output_tokens)} · {money(a.cost_usd)} (7d)
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 flex flex-col md:flex-row md:min-h-0">
        <div className="w-full md:w-96 shrink-0 max-h-[40dvh] md:max-h-none border-b md:border-b-0 md:border-r border-panel-border overflow-y-auto" data-testid="run-list">
          {runs.length === 0 && <div className="p-4 text-sm text-muted">No runs recorded yet. They appear here as soon as an agent starts working.</div>}
          {runs.map((r) => (
            <button
              key={r.id}
              onClick={() => {
                setSelected(r.id);
                if (window.innerWidth < 768) setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
              }}
              className={`w-full text-left px-4 py-3 border-b border-panel-border/60 ${selected === r.id ? "bg-wash-3" : "hover:bg-wash-1"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-medium truncate">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${r.status === "running" ? "animate-pulse" : ""}`} style={{ background: r.status === "error" ? "var(--danger)" : agentColor(r.agent_slug) }} />
                  {agentName(r.agent_slug)}
                </span>
                <span className="text-[11px] text-muted shrink-0">{fmtCentral(r.started_at, { weekday: undefined, timeZoneName: undefined })}</span>
              </div>
              <div className="text-xs text-muted truncate mt-0.5">
                {triggerName(r.trigger)}
                {r.prompt ? ` · ${r.prompt.replace(/\s+/g, " ").slice(0, 80)}` : ""}
              </div>
              <div className="text-[11px] text-muted mt-0.5">
                {r.status === "running" ? <span className="text-accent">working… </span> : `${secs(r.duration_ms)} · `}
                {fmtTokens(allTokens(r))} tokens · {r.tool_calls} tools{r.status !== "running" ? ` · ${runCost(r)}` : ""}
                {modelEffort(r) && <span data-testid="run-model"> · {modelEffort(r)}</span>}
              </div>
            </button>
          ))}
        </div>
        <div ref={detailRef} className="flex-1 min-w-0 md:overflow-y-auto scroll-mt-16">
          {selected ? (
            <>
              <button
                className="md:hidden text-xs text-accent px-4 pt-3"
                onClick={() => document.querySelector("[data-testid=run-list]")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              >
                ↑ All runs
              </button>
              <RunDetail id={selected} onOpen={setSelected} />
            </>
          ) : (
            <div className="p-6 text-sm text-muted">Pick a run.</div>
          )}
        </div>
      </div>
    </div>
  );
}
