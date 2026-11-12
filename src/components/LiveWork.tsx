"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

// The chat's "working" bubble: what the Chief of Staff (or whoever it delegated to) is doing
// right now, tokens burned so far, and a link to watch the whole run on the Activity page.

type Live = {
  run: { id: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; tool_calls: number; started_at: string; job_tokens?: number } | null;
  last: { agent_slug: string; kind: string; tool: string | null; content: string | null } | null;
};

const AGENT: Record<string, string> = { chief_of_staff: "Chief", full_stack_engineer: "Full Stack Engineer" };
export const agentName = (slug: string) => AGENT[slug] || slug.replace(/_/g, " ");
export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function describeStep(last: NonNullable<Live["last"]>) {
  const who = agentName(last.agent_slug);
  if (last.kind === "delegate") return `${who} handed this to ${agentName(last.tool || "")}`;
  if (last.kind === "tool_call") return `${who} is using ${(last.tool || "a tool").replace(/_/g, " ")}`;
  if (last.kind === "thinking") return `${who} is thinking`;
  return `${who} is writing`;
}

export default function LiveWork({ thread }: { thread: string }) {
  const [live, setLive] = useState<Live | null>(null);
  const [stopping, setStopping] = useState(false);

  async function stop() {
    setStopping(true);
    await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ thread }) }).catch(() => null);
  }
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const d = await fetch(`/api/runs?live=${encodeURIComponent(thread)}`).then((r) => r.json()).catch(() => null);
      if (!stop && d) setLive(d);
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [thread]);

  const run = live?.run;
  // Whole job: the Chief of Staff's run plus anything it handed off.
  const tokens = run ? run.job_tokens ?? run.input_tokens + run.cache_read_tokens + run.cache_write_tokens + run.output_tokens : 0;
  return (
    <div className="rounded-lg px-4 py-3 text-sm bg-panel border border-panel-border text-muted max-w-2xl" data-testid="live-work">
      <div className="flex items-center gap-2">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
        <span className="text-foreground/90 flex-1">{stopping ? "Stopping" : live?.last ? describeStep(live.last) : "Working on it"}…</span>
        <button
          onClick={stop}
          disabled={stopping}
          data-testid="stop-run"
          title="Stop Chief (and anything he handed off) right now"
          className="text-xs border border-danger/50 text-danger rounded px-2 py-0.5 hover:bg-danger/10 disabled:opacity-50"
        >
          ■ Stop
        </button>
      </div>
      {run && (
        <div className="text-xs mt-1 flex gap-3">
          <span>{fmtTokens(tokens)} tokens</span>
          <span>{run.tool_calls} tool call{run.tool_calls === 1 ? "" : "s"}</span>
          <Link href={`/team?view=activity&run=${run.id}`} className="text-accent hover:underline">
            Watch live →
          </Link>
        </div>
      )}
    </div>
  );
}
