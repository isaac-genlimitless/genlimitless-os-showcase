import db from "../db";
import { backupDatabase } from "../backup";

// Flight recorder for every agent run: what it thought, said, which tools it called (and what
// came back), who it delegated to, and how many tokens / dollars it burned. Written live as the
// run streams, so the Activity page and the chat's "working" bubble can follow along.

db.exec(`
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_slug TEXT NOT NULL,
  trigger TEXT NOT NULL,
  thread TEXT,                                 -- chat conversation key ('main' or a side chat id) for chat runs
  prompt TEXT,                                 -- what it was asked (trimmed)
  status TEXT NOT NULL DEFAULT 'running',      -- running | done | error
  summary TEXT,                                -- final answer (trimmed)
  input_tokens INTEGER NOT NULL DEFAULT 0,     -- live estimate while running, exact totals when done
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at);

CREATE TABLE IF NOT EXISTS agent_run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  agent_slug TEXT NOT NULL,                    -- who did it: the run's agent, or a subagent it delegated to
  kind TEXT NOT NULL,                          -- thinking | text | tool_call | tool_result | delegate | error
  tool TEXT,
  content TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_run_events_run ON agent_run_events(run_id, id);

-- Full text of tool results too big to hand the model whole (see shrinkResult in runtime.ts).
CREATE TABLE IF NOT EXISTS saved_tool_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  tool TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
{
  // Hand-offs run as their own runs, linked to the run that handed off.
  const cols = (db.prepare(`PRAGMA table_info(agent_runs)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("parent_run_id")) db.exec(`ALTER TABLE agent_runs ADD COLUMN parent_run_id INTEGER`);
  // Which model and effort each run used, so cost can be attributed. Additive, NULL for older runs.
  const missing = ["model", "effort"].filter((c) => !cols.includes(c));
  if (missing.length) {
    backupDatabase().catch(() => {}); // snapshot first (CLAUDE.md)
    for (const c of missing) db.exec(`ALTER TABLE agent_runs ADD COLUMN ${c} TEXT`);
  }
}

export type RunRow = {
  id: number;
  agent_slug: string;
  trigger: string;
  thread: string | null;
  parent_run_id: number | null;
  model: string | null;
  effort: string | null;
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

export type RunEvent = {
  id: number;
  run_id: number;
  agent_slug: string;
  kind: "thinking" | "text" | "tool_call" | "tool_result" | "delegate" | "error";
  tool: string | null;
  content: string | null;
  is_error: number;
  at: string;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// A server restart kills in-flight runs but leaves their rows on "running". Close them out once per
// server process (the scheduler loads this at boot, before any run can start).
{
  const gp = globalThis as unknown as { __agentRunsSwept?: boolean };
  if (!gp.__agentRunsSwept) {
    gp.__agentRunsSwept = true;
    db.prepare(`UPDATE agent_runs SET status='error', summary=COALESCE(summary,'Interrupted: the server restarted mid-run.'), ended_at=COALESCE(ended_at, datetime('now')) WHERE status='running'`).run();
  }
}

export function startRun(slug: string, trigger: string, prompt: string, thread?: string | null, parentRunId?: number | null, model?: string | null, effort?: string | null): number {
  const r = db
    .prepare(`INSERT INTO agent_runs (agent_slug, trigger, thread, prompt, parent_run_id, model, effort) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(slug, trigger, thread ?? null, clip(prompt, 4000), parentRunId ?? null, model ?? null, effort ?? null);
  return Number(r.lastInsertRowid);
}

export function addEvent(runId: number, e: { agent: string; kind: RunEvent["kind"]; tool?: string; content?: string; isError?: boolean }) {
  db.prepare(`INSERT INTO agent_run_events (run_id, agent_slug, kind, tool, content, is_error) VALUES (?, ?, ?, ?, ?, ?)`).run(
    runId,
    e.agent,
    e.kind,
    e.tool ?? null,
    e.content ? clip(e.content, e.kind === "thinking" || e.kind === "text" ? 8000 : 3000) : null,
    e.isError ? 1 : 0
  );
  if (e.kind === "tool_call") db.prepare(`UPDATE agent_runs SET tool_calls = tool_calls + 1 WHERE id=?`).run(runId);
}

/** Live token counter while a run streams (the final totals replace it in finishRun). */
// $ per million tokens (input, output). Cache writes bill at 1.25x input, cache reads at 0.1x.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10 }, // assumed same as Sonnet 5; confirm
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Cost from token counts, for runs that never get the SDK's exact figure (stopped, crashed, still running). */
export function estimateCost(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
  const p = PRICES[model] || PRICES["claude-sonnet-5-5"];
  return (u.input * p.input + u.output * p.output + u.cacheWrite * p.input * 1.25 + u.cacheRead * p.input * 0.1) / 1_000_000;
}

/** Live token totals (and an estimated cost) while a run works. A run that's stopped keeps these,
 *  so the Activity page never shows an expensive stopped run as $0. */
export function setLiveUsage(runId: number, u: { input: number; output: number; cacheRead: number; cacheWrite: number }, model: string) {
  db.prepare(`UPDATE agent_runs SET input_tokens=?, output_tokens=?, cache_read_tokens=?, cache_write_tokens=?, cost_usd=? WHERE id=? AND status='running'`).run(
    u.input,
    u.output,
    u.cacheRead,
    u.cacheWrite,
    estimateCost(model, u),
    runId
  );
}

export function finishRun(
  runId: number,
  r: {
    status: "done" | "error";
    summary: string;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number; cost: number };
    turns?: number;
    durationMs?: number;
  }
) {
  const sets = [`status=?`, `summary=?`, `ended_at=datetime('now')`];
  const vals: unknown[] = [r.status, clip(r.summary, 4000)];
  if (r.usage) {
    sets.push(`input_tokens=?`, `output_tokens=?`, `cache_read_tokens=?`, `cache_write_tokens=?`, `thinking_tokens=?`, `cost_usd=?`);
    vals.push(r.usage.input, r.usage.output, r.usage.cacheRead, r.usage.cacheWrite, r.usage.thinking, r.usage.cost);
  }
  if (r.turns !== undefined) { sets.push(`turns=?`); vals.push(r.turns); }
  if (r.durationMs !== undefined) { sets.push(`duration_ms=?`); vals.push(r.durationMs); }
  db.prepare(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id=?`).run(...vals, runId);
}

// ---------------------------------------------------------------- reads (Activity page, chat bubble)

export function listRuns(opts: { agent?: string; limit?: number; beforeId?: number } = {}): RunRow[] {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.agent) { where.push(`agent_slug=?`); vals.push(opts.agent); }
  if (opts.beforeId) { where.push(`id<?`); vals.push(opts.beforeId); }
  return db
    .prepare(`SELECT * FROM agent_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
    .all(...vals, opts.limit ?? 50) as RunRow[];
}

export function getRun(id: number): RunRow | undefined {
  return db.prepare(`SELECT * FROM agent_runs WHERE id=?`).get(id) as RunRow | undefined;
}

export function runEvents(runId: number, afterId = 0): RunEvent[] {
  return db.prepare(`SELECT * FROM agent_run_events WHERE run_id=? AND id>? ORDER BY id ASC LIMIT 2000`).all(runId, afterId) as RunEvent[];
}

export function childRuns(parentId: number): RunRow[] {
  return db.prepare(`SELECT * FROM agent_runs WHERE parent_run_id=? ORDER BY id ASC`).all(parentId) as RunRow[];
}

/** A run plus everything it handed off (recursively): tokens and cost for the whole job. */
export function jobTotals(runId: number) {
  const ids: number[] = [];
  const walk = (id: number) => {
    ids.push(id);
    for (const c of childRuns(id)) walk(c.id);
  };
  walk(runId);
  const q = db
    .prepare(
      `SELECT SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS tokens_in, SUM(output_tokens) AS tokens_out,
              SUM(tool_calls) AS tool_calls, SUM(cost_usd) AS cost_usd FROM agent_runs WHERE id IN (${ids.map(() => "?").join(",")})`
    )
    .get(...ids) as { tokens_in: number; tokens_out: number; tool_calls: number; cost_usd: number };
  return { runs: ids.length, ...q };
}

/** The chat run currently working on a conversation, with the latest step anywhere in it
 *  (including a hand-off it's waiting on), for the chat's "working" bubble. */
export function liveChatRun(thread: string) {
  const run = db
    .prepare(`SELECT * FROM agent_runs WHERE trigger='chat' AND thread=? AND status='running' ORDER BY id DESC LIMIT 1`)
    .get(thread) as RunRow | undefined;
  if (!run) return null;
  let active = run;
  for (let guard = 0; guard < 5; guard++) {
    const child = db.prepare(`SELECT * FROM agent_runs WHERE parent_run_id=? AND status='running' ORDER BY id DESC LIMIT 1`).get(active.id) as
      | RunRow
      | undefined;
    if (!child) break;
    active = child;
  }
  const last = db
    .prepare(`SELECT * FROM agent_run_events WHERE run_id=? AND kind IN ('tool_call','delegate','thinking','text') ORDER BY id DESC LIMIT 1`)
    .get(active.id) as RunEvent | undefined;
  const totals = jobTotals(run.id);
  return { run: { ...run, tool_calls: totals.tool_calls, job_tokens: (totals.tokens_in || 0) + (totals.tokens_out || 0) }, last: last || null };
}

/** Token and cost totals per agent over the last `hours`. */
export function usageTotals(hours: number) {
  const rows = db
    .prepare(
      `SELECT agent_slug,
              COUNT(*) AS runs,
              SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(thinking_tokens) AS thinking_tokens,
              SUM(tool_calls) AS tool_calls,
              SUM(cost_usd) AS cost_usd
       FROM agent_runs WHERE started_at > datetime('now', ?) GROUP BY agent_slug ORDER BY cost_usd DESC`
    )
    .all(`-${hours} hours`) as {
    agent_slug: string;
    runs: number;
    input_tokens: number;
    output_tokens: number;
    thinking_tokens: number;
    tool_calls: number;
    cost_usd: number;
  }[];
  const total = rows.reduce(
    (t, r) => ({
      runs: t.runs + r.runs,
      input_tokens: t.input_tokens + (r.input_tokens || 0),
      output_tokens: t.output_tokens + (r.output_tokens || 0),
      thinking_tokens: t.thinking_tokens + (r.thinking_tokens || 0),
      tool_calls: t.tool_calls + (r.tool_calls || 0),
      cost_usd: t.cost_usd + (r.cost_usd || 0),
    }),
    { runs: 0, input_tokens: 0, output_tokens: 0, thinking_tokens: 0, tool_calls: 0, cost_usd: 0 }
  );
  const byModel = db
    .prepare(
      `SELECT COALESCE(model, 'unknown') AS model, COUNT(*) AS runs, SUM(cost_usd) AS cost_usd
       FROM agent_runs WHERE started_at > datetime('now', ?) GROUP BY COALESCE(model, 'unknown') ORDER BY cost_usd DESC`
    )
    .all(`-${hours} hours`) as { model: string; runs: number; cost_usd: number }[];
  return { byAgent: rows, byModel, total };
}

// ---------------------------------------------------------------- stopping runs
// Every running agent registers its AbortController here so Owner can stop it (Stop button in
// chat and on the Activity page), and so the runtime's time cap can end runaway runs.
// On globalThis because each route file is its own module instance in dev.

const g = globalThis as unknown as { __agentRunAborts?: Map<number, { ctrl: AbortController; why?: string }> };
const aborts = (g.__agentRunAborts ??= new Map());

export function registerRun(runId: number, ctrl: AbortController) {
  aborts.set(runId, { ctrl });
}

export function unregisterRun(runId: number) {
  aborts.delete(runId);
}

/** Why a run was stopped (null if it wasn't). */
export function stopReason(runId: number): string | null {
  return aborts.get(runId)?.why ?? null;
}

export function stopRun(runId: number, why = "Stopped by Owner."): { stopped: boolean; note?: string } {
  // Stop anything it handed off first, so no hand-off keeps working after its parent is gone.
  for (const c of db.prepare(`SELECT id FROM agent_runs WHERE parent_run_id=? AND status='running'`).all(runId) as { id: number }[]) {
    stopRun(c.id, why);
  }
  const entry = aborts.get(runId);
  if (!entry) {
    // Not running in this server process (e.g. left over from before a restart): just close it out.
    db.prepare(`UPDATE agent_runs SET status='error', summary=?, ended_at=datetime('now') WHERE id=? AND status='running'`).run(why, runId);
    return { stopped: false, note: "It wasn't running in this server anymore; marked as stopped." };
  }
  entry.why = why;
  entry.ctrl.abort(why);
  return { stopped: true };
}

/** Stop whatever is answering this chat conversation. */
export function stopChat(thread: string) {
  const run = db.prepare(`SELECT id FROM agent_runs WHERE trigger='chat' AND thread=? AND status='running' ORDER BY id DESC LIMIT 1`).get(thread) as
    | { id: number }
    | undefined;
  return run ? { run_id: run.id, ...stopRun(run.id) } : { stopped: false, note: "Nothing is running in this chat." };
}

// ---------------------------------------------------------------- saved tool results

export function saveToolResult(runId: number, tool: string, content: string): number {
  return Number(db.prepare(`INSERT INTO saved_tool_results (run_id, tool, content) VALUES (?, ?, ?)`).run(runId, tool, content).lastInsertRowid);
}

/** A slice of a saved result, for get_saved_result. */
export function readSavedResult(id: number, offset = 0, length = 6000) {
  const row = db.prepare(`SELECT tool, content FROM saved_tool_results WHERE id=?`).get(id) as { tool: string; content: string } | undefined;
  if (!row) throw new Error(`No saved result #${id}`);
  const len = Math.min(Math.max(length, 500), 8000);
  const end = Math.min(offset + len, row.content.length);
  return {
    tool: row.tool,
    total_chars: row.content.length,
    offset,
    text: row.content.slice(offset, end),
    next_offset: end < row.content.length ? end : null,
  };
}
