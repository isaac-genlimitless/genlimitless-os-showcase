"use client";
import { useCallback, useEffect, useState } from "react";

export default function AgentSchedulesCard() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/agent-schedules", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setRows(j.schedules);
      setErr(null);
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(id: number, enabled: boolean) {
    try {
      const r = await fetch("/api/agent-schedules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setRows(j.schedules);
      setErr(null);
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }

  return (
    <section className="bg-panel border border-panel-border rounded-lg p-5 space-y-4" data-testid="agent-schedules-card">
      <h2 className="text-lg font-semibold">Agent schedules</h2>
      {err && <p className="text-sm text-red-600">Couldn&apos;t read agent schedules: {err}</p>}
      {!rows && !err && <p className="text-sm opacity-70">Loading...</p>}
      {rows?.map((s) => (
        <div key={s.id} className="border border-panel-border rounded p-3 space-y-1 text-sm" data-testid="agent-schedule-row">
          <div className="flex items-center gap-3">
            <span className="font-medium">{s.agent_slug}</span>
            <span className="opacity-70">{s.description}</span>
            {!s.agentFound && <span className="text-red-600">agent not found</span>}
            <label className="ml-auto flex items-center gap-1">
              <input
                type="checkbox"
                checked={!!s.enabled}
                onChange={(e) => toggle(s.id, e.target.checked)}
                data-testid="agent-schedule-enabled"
              />
              Enabled
            </label>
          </div>
          <p className="opacity-80">{s.task}</p>
          <p>Next run: {s.nextRunLabel}</p>
          {s.last_status && (
            <p className="opacity-80">
              Last run: {s.last_run_at ? `${s.last_run_at} UTC, ` : ""}
              {s.last_status}
              {s.last_error ? ` - ${s.last_error}` : s.last_summary ? ` - ${String(s.last_summary).slice(0, 160)}` : ""}
            </p>
          )}
        </div>
      ))}
      <p className="text-xs opacity-70">
        Runs automatically; if the server was down at the scheduled time it catches up on the next start. The report is posted to chat.
      </p>
    </section>
  );
}
