"use client";
import { useOwnerName } from "@/components/CellContext";
import { fmtCentral } from "@/lib/time";
import { EFFORTS, MODELS } from "@/lib/model-policy";
import { useEffect, useState } from "react";
import ActivityView from "@/components/ActivityView";

type Learning = { id: number; lesson: string; source: string; created_at: string };
type Agent = {
  slug: string;
  name: string;
  kind: "core" | "custom";
  reports_to: string | null;
  objective: string;
  responsibilities: string;
  instructions: string;
  default_model: string | null;
  default_effort: string | null;
  status: "active" | "retired";
  created_by: string;
  retired_reason: string | null;
  tools: string[];
  learnings: Learning[];
  raw_signals: number;
};
type Approval = { id: number; requested_by: string; action: string; target_id: number | null; title: string; reason: string | null; created_at: string };
type Escalation = { id: number; from_agent: string; severity: string; kind: string; title: string; detail: string | null; created_at: string };
type Priority = { id: number; title: string; detail: string | null; rank: number };
type Activity = { id: number; agent_slug: string; trigger: string; summary: string; created_at: string };
type Change = { id: number; agent_slug: string; changed_by: string; field: string; reason: string | null; created_at: string };

type Data = {
  agents: Agent[];
  approvals: Approval[];
  escalations: Escalation[];
  priorities: Priority[];
  activity: Activity[];
  changes: Change[];
  majorFixes: number;
  emailDrafts: number;
};

const when = (s: string) => fmtCentral(s);
const sevColor: Record<string, string> = { critical: "text-danger", important: "text-accent", fyi: "text-muted" };

async function post(body: object) {
  const res = await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) alert(data.error || "Something went wrong");
  return data;
}

function AgentCard({ agent, name, onChange, lead }: { agent: Agent; name: (slug: string | null) => string; onChange: () => void; lead?: boolean }) {
  const ownerName = useOwnerName();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ objective: agent.objective, responsibilities: agent.responsibilities, instructions: agent.instructions });
  const [lesson, setLesson] = useState("");

  async function save() {
    await post({ action: "update_agent", slug: agent.slug, ...draft });
    setEditing(false);
    onChange();
  }

  return (
    <div
      data-testid={`agent-${agent.slug}`}
      className={`min-w-0 break-anywhere bg-panel border rounded-lg p-5 ${lead ? "border-gold/50" : "border-panel-border"} ${agent.status === "retired" ? "opacity-50" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-display text-xl tracking-wide">{agent.name}</div>
          <div className="text-xs text-muted mt-0.5">
            {agent.kind === "core" ? "Core" : `Created by ${agent.created_by === "chief_of_staff" ? "Chief" : ownerName}`}
            {agent.reports_to ? ` · reports to ${name(agent.reports_to)}` : ` · reports to ${ownerName}`}
          </div>
        </div>
        <span className={`text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 shrink-0 ${agent.status === "active" ? "border-success/50 text-success" : "border-panel-border text-muted"}`}>
          {agent.status}
        </span>
      </div>

      <div className="mt-3 text-xs uppercase tracking-wide text-muted">Objective</div>
      <div className="text-sm mt-1 break-anywhere">{agent.objective}</div>
      {agent.retired_reason && <div className="text-xs text-muted mt-2">Retired: {agent.retired_reason}</div>}

      <div className="flex flex-wrap gap-3 mt-3 text-xs">
        <button onClick={() => setOpen(!open)} className="text-accent hover:underline">
          {open ? "Hide details" : "Details, instructions & learnings"}
        </button>
        {agent.learnings.length > 0 && <span className="text-muted">{agent.learnings.length} learnings</span>}
        {agent.raw_signals > 0 && <span className="text-muted">{agent.raw_signals} feedback signals to process tonight</span>}
      </div>

      {open && (
        <div className="mt-4 space-y-4 text-sm">
          <div className="flex flex-wrap gap-3 items-center text-xs">
            <span className="uppercase tracking-wide text-muted">Default model</span>
            <select
              data-testid={`default-model-${agent.slug}`}
              value={agent.default_model || ""}
              onChange={async (e) => {
                await post({ action: "update_agent", slug: agent.slug, default_model: e.target.value, ...(e.target.value === "claude-haiku-4-5" ? { default_effort: "" } : {}), reason: "default model set by Owner on the Team page" });
                onChange();
              }}
              className="bg-wash-2 border border-panel-border rounded px-2 py-1"
            >
              <option value="">Automatic</option>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <select
              data-testid={`default-effort-${agent.slug}`}
              value={agent.default_effort || ""}
              disabled={agent.default_model === "claude-haiku-4-5"}
              onChange={async (e) => {
                await post({ action: "update_agent", slug: agent.slug, default_effort: e.target.value, reason: `default effort set by ${ownerName} on the Team page` });
                onChange();
              }}
              className="bg-wash-2 border border-panel-border rounded px-2 py-1"
            >
              <option value="">Automatic effort</option>
              {EFFORTS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </div>
          {editing ? (
            <div className="space-y-3">
              {(["objective", "responsibilities", "instructions"] as const).map((f) => (
                <label key={f} className="block">
                  <span className="text-xs uppercase tracking-wide text-muted">{f}</span>
                  <textarea
                    value={draft[f]}
                    onChange={(e) => setDraft({ ...draft, [f]: e.target.value })}
                    rows={f === "objective" ? 3 : 7}
                    className="mt-1 w-full bg-wash-2 border border-panel-border rounded p-2 text-base md:text-sm focus:border-gold outline-none"
                  />
                </label>
              ))}
              <div className="flex gap-2">
                <button onClick={save} className="bg-gold text-black text-xs font-semibold px-3 py-1.5 rounded hover:bg-gold-soft min-h-[44px] md:min-h-0">
                  Save
                </button>
                <button onClick={() => setEditing(false)} className="border border-panel-border text-xs px-3 py-1.5 rounded hover:border-gold min-h-[44px] md:min-h-0">
                  Cancel
                </button>
              </div>
              <div className="text-xs text-muted">Guardrails (no sending or deleting without you) are fixed in code and always apply.</div>
            </div>
          ) : (
            <>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted">Responsibilities</div>
                <div className="whitespace-pre-wrap break-anywhere mt-1">{agent.responsibilities}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted">Operating instructions</div>
                <div className="whitespace-pre-wrap break-anywhere mt-1">{agent.instructions || "(none)"}</div>
              </div>
              <button onClick={() => setEditing(true)} className="border border-panel-border text-xs px-3 py-1.5 rounded hover:border-gold min-h-[44px] md:min-h-0">
                Edit instructions
              </button>
            </>
          )}

          <div>
            <div className="text-xs uppercase tracking-wide text-muted">Learned from you</div>
            {agent.learnings.length === 0 && <div className="text-muted text-xs mt-1">Nothing yet.</div>}
            <ul className="mt-1 space-y-1">
              {agent.learnings.map((l) => (
                <li key={l.id} className="flex items-start justify-between gap-3">
                  <span className="min-w-0 break-anywhere whitespace-pre-wrap">{l.lesson}</span>
                  <button
                    onClick={async () => {
                      await post({ action: "retire_learning", id: l.id });
                      onChange();
                    }}
                    className="text-xs text-muted hover:text-accent shrink-0"
                    title="Retire this learning (kept in history)"
                  >
                    Retire
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="flex gap-2 mt-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!lesson.trim()) return;
                await post({ action: "add_learning", slug: agent.slug, lesson: lesson.trim() });
                setLesson("");
                onChange();
              }}
            >
              <input
                value={lesson}
                onChange={(e) => setLesson(e.target.value)}
                placeholder={`Teach ${agent.name} something…`}
                className="flex-1 min-w-0 bg-wash-2 border border-panel-border rounded px-2 py-1.5 text-base md:text-sm focus:border-gold outline-none"
/>
              <button className="border border-panel-border text-xs px-3 rounded hover:border-gold">Add</button>
            </form>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wide text-muted">Tools</div>
            <div className="flex flex-wrap gap-1 mt-1">
              {agent.tools.map((t) => (
                <span key={t} className="break-anywhere text-[11px]bg-wash-2 border border-panel-border rounded px-1.5 py-0.5">
                  {t}
                </span>
              ))}
            </div>
          </div>

          {agent.kind === "custom" && (
            <button
              onClick={async () => {
                await post({ action: agent.status === "active" ? "retire_agent" : "restore_agent", slug: agent.slug });
                onChange();
              }}
              className="border border-panel-border text-xs px-3 py-1.5 rounded hover:border-gold min-h-[44px] md:min-h-0"
            >
              {agent.status === "active" ? "Retire agent" : "Restore agent"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TeamView() {
  const ownerName = useOwnerName();
  const [data, setData] = useState<Data | null>(null);
  const [priority, setPriority] = useState("");
  const [showRetired, setShowRetired] = useState(false);

  async function load() {
    setData(await fetch("/api/agents").then((r) => r.json()));
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  if (!data) return <div className="p-4 md:p-8 text-muted text-sm">Loading…</div>;

  const byslug = new Map(data.agents.map((a) => [a.slug, a]));
  const name = (slug: string | null) => (slug ? byslug.get(slug)?.name || slug : ownerName);
  const cos = byslug.get("chief_of_staff");
  const team = data.agents.filter((a) => a.slug !== "chief_of_staff" && (showRetired || a.status === "active"));
  const retiredCount = data.agents.filter((a) => a.status === "retired").length;
  const urgent = data.escalations.filter((e) => e.severity !== "fyi");
  const needsYou = data.approvals.length + urgent.length + data.majorFixes + data.emailDrafts;

  return (
    <div className="team-page p-4 md:p-8space-y-8 max-w-6xl">
      <div>
        <h1 className="font-display text-3xl tracking-wide">Team</h1>
        <p className="text-sm text-muted mt-1 max-w-2xl">
          Chief runs the team: he hands out work, checks it, creates and retires agents, and keeps you on task. No agent can send anything or delete anything without your approval.
        </p>
      </div>

      {needsYou > 0 && (
        <div className="bg-panel border border-gold/40 rounded-lg p-5 space-y-4" data-testid="needs-approval">
          <h2 className="text-sm uppercase tracking-wide text-accent">Needs you ({needsYou})</h2>
          {data.emailDrafts > 0 && (
            <a href="/communications?tab=email" className="block text-sm hover:text-accent">
              {data.emailDrafts} email draft{data.emailDrafts > 1 ? "s" : ""} waiting for you to approve → Communications, Email
            </a>
          )}
          {data.majorFixes > 0 && (
            <a href="/analytics#fixes" className="block text-sm hover:text-accent">
              {data.majorFixes} code change{data.majorFixes > 1 ? "s" : ""} Chief reviewed and sent to you → Settings, Proposed fixes
            </a>
          )}
          {data.approvals.map((a) => (
            <div key={a.id} className="text-sm border-t border-panel-border pt-3 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4">
              <div className="min-w-0 break-anywhere">
                <div className="font-medium">{a.title}</div>
                <div className="text-muted text-xs mt-0.5">
                  {name(a.requested_by)} asks to {a.action.replace(/_/g, " ")}
                  {a.target_id ? ` #${a.target_id}` : ""} · {when(a.created_at)}
                </div>
                {a.reason && <div className="text-muted mt-1">{a.reason}</div>}
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={async () => {
                    await post({ action: "decide_approval", id: a.id, decision: "approve" });
                    load();
                  }}
                  className="bg-gold text-black text-xs font-semibold px-3 py-1.5 rounded hover:bg-gold-soft min-h-[44px] sm:min-h-0 min-w-[44px]"
                >
                  Approve
                </button>
                <button
                  onClick={async () => {
                    await post({ action: "decide_approval", id: a.id, decision: "decline" });
                    load();
                  }}
                  className="border border-panel-border text-xs px-3 py-1.5 rounded hover:border-gold min-h-[44px] sm:min-h-0 min-w-[44px]"
                >
                  Decline
                </button>
              </div>
            </div>
          ))}
          {urgent.map((e) => (
            <div key={e.id} className="text-sm border-t border-panel-border pt-3 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4">
              <div className="min-w-0 break-anywhere">
                <div className="font-medium">
                  <span className={`text-xs uppercase mr-2 ${sevColor[e.severity]}`}>{e.severity}</span>
                  {e.title}
                </div>
                <div className="text-muted text-xs mt-0.5">
                  from {name(e.from_agent)} · {when(e.created_at)}
                </div>
                {e.detail && <div className="text-muted mt-1 whitespace-pre-wrap">{e.detail}</div>}
              </div>
              <button
                onClick={async () => {
                  await post({ action: "handle_escalation", id: e.id });
                  load();
                }}
                className="border border-panel-border text-xs px-3 py-1.5 rounded hover:border-gold shrink-0 self-start min-h-[44px] sm:min-h-0 min-w-[44px]"
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-4">
        {cos && (
          <div className="max-w-3xl">
            <AgentCard agent={cos} name={name} onChange={load} lead />
          </div>
        )}
        <div className="flex items-center justify-between">
          <h2 className="text-sm uppercase tracking-wide text-muted">Reports to Chief</h2>
          {retiredCount > 0 && (
            <button onClick={() => setShowRetired(!showRetired)} className="text-xs text-muted hover:text-accent">
              {showRetired ? "Hide" : "Show"} retired ({retiredCount})
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {team.map((a) => (
            <AgentCard key={a.slug} agent={a} name={name} onChange={load} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-panel border border-panel-border rounded-lg p-5">
          <h2 className="text-sm uppercase tracking-wide text-muted mb-3">Your priorities</h2>
          <p className="text-xs text-muted mb-3">Chief keeps you on these and flags work that pulls you off them.</p>
          <ol className="space-y-2 text-sm">
            {data.priorities.map((p) => (
              <li key={p.id} className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-anywhere">
                  {p.title}
                  {p.detail && <span className="text-muted">: {p.detail}</span>}
                </span>
                <button
                  onClick={async () => {
                    await post({ action: "set_priority", id: p.id, status: "done" });
                    load();
                  }}
                  className="text-xs text-muted hover:text-accent shrink-0"
                >
                  Done
                </button>
              </li>
            ))}
            {data.priorities.length === 0 && <li className="text-muted text-xs">None yet. Tell Chief what matters this week.</li>}
          </ol>
          <form
            className="flex gap-2 mt-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!priority.trim()) return;
              await post({ action: "set_priority", title: priority.trim(), rank: (data.priorities.at(-1)?.rank ?? 0) + 1 });
              setPriority("");
              load();
            }}
          >
            <input
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              placeholder="Add a priority…"
              className="flex-1 min-w-0 bg-wash-2 border border-panel-border rounded px-2 py-1.5 text-sm focus:border-gold outline-none"
            />
            <button className="border border-panel-border text-xs px-3 rounded hover:border-gold">Add</button>
          </form>
        </div>

        <div className="bg-panel border border-panel-border rounded-lg p-5">
          <h2 className="text-sm uppercase tracking-wide text-muted mb-3">Recent activity (48h)</h2>
          <div className="space-y-3 max-h-96 overflow-y-auto text-sm">
            {data.activity.length === 0 && <div className="text-muted text-xs">Nothing yet.</div>}
            {data.activity.map((a) => (
              <div key={a.id} className="border-b border-panel-border pb-2 last:border-0">
                <div className="text-xs text-muted">
                  {name(a.agent_slug)} · {a.trigger.replace(/_/g, " ")} · {when(a.created_at)}
                </div>
                <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-anywhere">{a.summary}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {data.changes.length > 0 && (
        <div className="bg-panel border border-panel-border rounded-lg p-5">
          <h2 className="text-sm uppercase tracking-wide text-muted mb-3">Team changes</h2>
          <div className="space-y-1 text-sm">
            {data.changes.map((c) => (
              <div key={c.id} className="break-anywhere">
                <span className="text-muted text-xs">{when(c.created_at)} · </span>
                {c.changed_by === "owner" ? "You" : name(c.changed_by)} changed {name(c.agent_slug)}&apos;s {c.field}
                {c.reason && <span className="text-muted">: {c.reason}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function TeamPage() {
  const [view, setView] = useState<"team" | "activity">("team");

  // Read ?view=activity (and ?run=N, which ActivityView reads itself) once on mount, like the old Activity page did.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("view") === "activity") setView("activity");
  }, []);

  function choose(next: "team" | "activity") {
    setView(next);
    const run = new URLSearchParams(window.location.search).get("run");
    const url = next === "activity" ? `/team?view=activity${run ? `&run=${encodeURIComponent(run)}` : ""}` : "/team";
    window.history.replaceState(null, "", url);
  }

  const tab = (id: "team" | "activity", label: string) => (
    <button
      type="button"
      onClick={() => choose(id)}
      data-testid={`team-view-${id}`}
      aria-pressed={view === id}
      className={`px-3 py-1.5 text-sm rounded-full border ${view === id ? "bg-gold text-black border-gold font-semibold" : "border-panel-border text-muted hover:text-foreground"}`}
    >
      {label}
    </button>
  );

  return (
    <div className={view === "activity" ? "flex flex-col md:h-full" : ""}>
      <div className="px-4 md:px-8 pt-4 flex gap-2" data-testid="team-view-tabs">
        {tab("team", "Team")}
        {tab("activity", "Activity")}
      </div>
      {view === "activity" ? <ActivityView /> : <TeamView />}
    </div>
  );
}
