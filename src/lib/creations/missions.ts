import { nameFor } from "../instance";
import { query as sdkQuery, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import db from "../db";
import { LOCKED_BASE, SECRET_READ_DENY } from "../agent-lock";
import { addEvent, finishRun, registerRun, setLiveUsage, startRun, stopRun, unregisterRun, estimateCost } from "../agents/runs";
import { DEFAULT_MODEL } from "../model-policy";
import { BUSINESS_TZ } from "../time";
import {
  OWNER, addComment, createSandbox, ensureCreationsSchema, getCreation, getSandbox, proposePromotion, roleOf, saveArtifact,
} from "./store";
import { billed, planBudget, remaining, shouldStop, type Usage } from "./budget";
import { compute } from "./models/site-pnl";
import { normalizePlan, utilization } from "./models/site-plan";
import { normalizeSites, rankSites } from "./models/site-finder";
import { proposeStep } from "./execution";

// Autonomous creation agents ("missions"). Each mission is one agent with one goal, working ONLY in its
// own new sandbox: it can read canon, write artifacts in its sandbox, run the models, comment, and
// propose its sandbox back to canon (a proposal Owner approves or declines). It has no tool that sends,
// books, deletes, writes to Notion, or touches anything outside this creation's tables.
// Spend is counted per model call into creation_token_ledger and held under the rolling 1M cap.

export const ROLES = {
  inventor: { label: "Inventor", builtins: [] as string[], charter: "Generate genuinely new directions. Invert assumptions from the tear-down, borrow structures from unrelated fields, push ideas to extremes, then pick the strongest few and write each up clearly (what it is, why it could work, what would have to be true)." },
  researcher: { label: "Researcher", builtins: ["WebSearch"], charter: "Find facts that change decisions: prior art, failed attempts and why, market data, regulations, zoning, real costs. Every claim gets a source URL. Say plainly when you could not verify something. Never invent numbers." },
  modeler: { label: "Modeler", builtins: [] as string[], charter: "Stress the economics. Use run_site_model to test scenarios (bad case, base case, good case) and find which inputs decide whether a site pays for itself. Write findings as a doc, and update the model's inputs in your sandbox only when you can justify each change." },
  architect: { label: "Architect", builtins: [] as string[], charter: "Design the physical site. Use plan_utilization to test layouts and schedules; aim for a building that earns day and night. Write the plan as a plan artifact in your sandbox and explain the trade-offs in a doc." },
  skeptic: { label: "Skeptic", builtins: [] as string[], charter: "Attack the current canon as specific stakeholders would: a parent, a student, a facilitator, a county planner, a lender, a competitor, a regulator. Find the weakest assumptions and what would break first. Be concrete and fair; suggest how each weakness could be tested or fixed." },
  producer: { label: "Producer", builtins: [] as string[], charter: "Turn canon into an execution plan: the next concrete real-world steps, in order. Use propose_step for each one (task, email draft, meeting, or a manual step like a call or site visit). Only propose emails or meetings to addresses that appear in canon or that Owner gave you; otherwise make it a task to find the right person. Steps are only proposals: Owner approves each one, and approved emails still wait for him to press send." },
} as const;
export type RoleKey = keyof typeof ROLES;
export const isRole = (r: unknown): r is RoleKey => typeof r === "string" && r in ROLES;

export interface Mission {
  id: number; creation_id: number; sandbox_id: number | null; role: RoleKey; goal: string;
  status: "queued" | "running" | "done" | "stopped" | "failed" | "cancelled";
  budget_tokens: number; used_tokens: number; run_id: number | null; report: string | null; stop_reason: string | null;
  started_by: string; scheduled_for: string | null; created_at: string; started_at: string | null; ended_at: string | null;
}

function fail(msg: string): never {
  throw new Error(msg);
}

// ---------- budget bookkeeping ----------

export function spentLast24h(): number {
  return (db.prepare(`SELECT COALESCE(SUM(tokens), 0) AS n FROM creation_token_ledger WHERE at > datetime('now', '-1 day')`).get() as { n: number }).n;
}

function reservedByRunning(exceptId?: number): number {
  return (db.prepare(`SELECT COALESCE(SUM(MAX(budget_tokens - used_tokens, 0)), 0) AS n FROM creation_missions WHERE status = 'running' AND id != ?`).get(exceptId ?? 0) as { n: number }).n;
}

export function budgetStatus() {
  const spent = spentLast24h();
  const reserved = reservedByRunning();
  return { cap: 1_000_000, spent24h: spent, reserved, remaining: remaining(spent, reserved) };
}

// ---------- missions ----------

const SWEEP = globalThis as unknown as { __creationMissionsSwept?: boolean };
function sweepInterrupted() {
  if (SWEEP.__creationMissionsSwept) return;
  SWEEP.__creationMissionsSwept = true;
  db.prepare(`UPDATE creation_missions SET status='failed', stop_reason=COALESCE(stop_reason,'Interrupted: the server restarted mid-run.'), ended_at=datetime('now') WHERE status='running'`).run();
}

/** Next 1:00 AM in Central time, as a UTC 'YYYY-MM-DD HH:MM:SS' string. */
export function tonightUtc(now = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const t = new Date(Math.ceil(now.getTime() / 900_000) * 900_000);
  for (let i = 0; i < 4 * 48; i++, t.setTime(t.getTime() + 900_000)) {
    const parts = Object.fromEntries(fmt.formatToParts(t).map((p) => [p.type, p.value]));
    if (Number(parts.hour) === 1 && Number(parts.minute) === 0 && t > now) return t.toISOString().slice(0, 19).replace("T", " ");
  }
  return new Date(now.getTime() + 6 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}

function creationIdBySlug(slug: string): number {
  const r = db.prepare(`SELECT id FROM creations WHERE slug = ? AND status = 'active'`).get(slug) as { id: number } | undefined;
  if (!r) fail("creation not found");
  return r.id;
}

/** Owner-only for now. Budget is checked when it's queued and again when it starts. */
export function createMission(slug: string, input: Record<string, unknown>, actor = OWNER): Mission {
  sweepInterrupted();
  const cid = creationIdBySlug(slug);
  if (roleOf(cid, actor) !== "owner") fail("only the owner can start agents");
  if (!isRole(input.role)) fail(`role must be one of ${Object.keys(ROLES).join(", ")}`);
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (goal.length < 10) fail("give the agent a goal (at least a sentence)");
  if (goal.length > 2000) fail("goal is too long (max 2000)");
  const plan = planBudget(input.budget === undefined ? undefined : Number(input.budget), budgetStatus().remaining);
  if (!plan.ok) fail(plan.reason);
  const when = input.when === "tonight" ? tonightUtc() : null;
  const info = db.prepare(`INSERT INTO creation_missions (creation_id, role, goal, budget_tokens, started_by, scheduled_for) VALUES (?,?,?,?,?,?)`)
    .run(cid, input.role, goal, plan.budget, actor, when);
  const m = getMission(Number(info.lastInsertRowid));
  db.prepare(`INSERT INTO creation_feed (creation_id, kind, title, body, ref_type, ref_id, actor, resolved_at) VALUES (?, 'mission', ?, ?, 'mission', ?, ?, datetime('now'))`)
    .run(cid, `${ROLES[m.role].label} mission queued${when ? " for tonight" : ""}`, goal, m.id, actor);
  return m;
}

export function getMission(id: number): Mission {
  const m = db.prepare(`SELECT * FROM creation_missions WHERE id = ?`).get(id) as Mission | undefined;
  if (!m) fail("mission not found");
  return m;
}

export function listMissions(slug: string, actor = OWNER): Mission[] {
  sweepInterrupted();
  const cid = creationIdBySlug(slug);
  if (!roleOf(cid, actor)) fail("creation not found");
  return db.prepare(`SELECT * FROM creation_missions WHERE creation_id = ? ORDER BY id DESC LIMIT 50`).all(cid) as Mission[];
}

const controllers = new Map<number, AbortController>();

/** Cancel a queued mission, or stop a running one (it keeps what it already wrote in its sandbox). */
export function stopMission(id: number, actor = OWNER): Mission {
  const m = getMission(id);
  if (roleOf(m.creation_id, actor) !== "owner") fail("only the owner can stop agents");
  if (m.status === "queued") {
    db.prepare(`UPDATE creation_missions SET status='cancelled', ended_at=datetime('now') WHERE id = ?`).run(id);
  } else if (m.status === "running") {
    db.prepare(`UPDATE creation_missions SET stop_reason='Stopped by Owner.' WHERE id = ?`).run(id);
    if (m.run_id) stopRun(m.run_id, "Stopped by Owner.");
    controllers.get(id)?.abort();
  } else fail(`that mission is already ${m.status}`);
  return getMission(id);
}

// ---------- the agent's tools (bound to one mission's sandbox) ----------

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n…[cut at ${n} chars]` : s);
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export interface MissionCtx { slug: string; creationId: number; sandboxId: number; actor: string; missionId: number; finished: { report: string | null } }

/** The tool bodies as plain functions (tested directly; the SDK wrappers below only adapt them). */
export function missionToolHandlers(ctx: MissionCtx) {
  const brief = (a: { key: string; kind: string; title: string; body: string; data: unknown }, n: number) =>
    `### ${a.title}  [key: ${a.key}, kind: ${a.kind}]\n${clip(a.body || "", n)}${a.data != null ? `\nDATA: ${clip(JSON.stringify(a.data), n)}` : ""}`;
  return {
    read_canon: () => {
      const d = getCreation(ctx.slug);
      return `Canon v${d.canon.version.number} of "${d.creation.title}" (phase: ${d.creation.phase}).\n\n` + d.canon.artifacts.map((a) => brief(a, 2500)).join("\n\n");
    },
    read_sandbox: () => {
      const s = getSandbox(ctx.sandboxId);
      const changed = s.changes.map((c) => `${c.op} ${c.key}`).join(", ") || "none yet";
      return `Your sandbox #${ctx.sandboxId}. Changes vs canon: ${changed}.\n\n` + s.artifacts.map((a) => brief(a, 1500)).join("\n\n");
    },
    read_artifact: ({ key, from }: { key: string; from?: "canon" | "sandbox" }) => {
      const list = from === "canon" ? getCreation(ctx.slug).canon.artifacts : getSandbox(ctx.sandboxId).artifacts;
      const a = list.find((x) => x.key === key);
      return a ? brief(a, 12000) : `No artifact "${key}" in ${from === "canon" ? "canon" : "your sandbox"}.`;
    },
    write_doc: ({ key, title, body }: { key?: string; title: string; body: string }) => {
      const a = saveArtifact(ctx.sandboxId, { key, kind: "doc", title, body }, ctx.actor);
      return `Saved doc "${a.title}" (key ${a.key}) in your sandbox.`;
    },
    write_data: ({ key, kind, title, body, data }: { key: string; kind: "model" | "map" | "plan" | "sites"; title: string; body?: string; data: unknown }) => {
      const a = saveArtifact(ctx.sandboxId, { key, kind, title, body: body ?? "", data }, ctx.actor);
      return `Saved ${a.kind} "${a.title}" (key ${a.key}) in your sandbox.`;
    },
    run_site_model: ({ inputs }: { inputs: Record<string, number> }) => {
      const r = compute(inputs);
      const lines = (l: { label: string; amount: number }[]) => l.map((x) => `  ${x.label}: $${Math.round(x.amount).toLocaleString()}`).join("\n");
      return `Net/yr $${Math.round(r.net).toLocaleString()} (margin ${(r.margin * 100).toFixed(0)}%). Engines cover ${(r.spaceCoveredPct * 100).toFixed(0)}% of the building ($${Math.round(r.spaceCost).toLocaleString()}/yr). Break-even drop-off students: ${r.breakEvenStudents ?? "none ≤2000"}. Payback: ${r.paybackYears ? r.paybackYears.toFixed(1) + " yrs" : "n/a"}.\nIn:\n${lines(r.revenue)}\nOut:\n${lines(r.costs)}`;
    },
    plan_utilization: ({ plan }: { plan: unknown }) => {
      const u = utilization(normalizePlan(plan));
      return `Indoor ${Math.round(u.indoorSqft).toLocaleString()} sq ft (${(u.coverage * 100).toFixed(1)}% lot coverage). In use ${(u.weekly * 100).toFixed(0)}% of all hours vs ${(u.schoolHoursOnly * 100).toFixed(0)}% from school hours alone. By program (sq-ft-hours/wk): ${u.byWho.map((w) => `${w.who} ${Math.round(w.sqftHours).toLocaleString()}`).join("; ")}.`;
    },
    rank_sites: ({ data }: { data: unknown }) =>
      rankSites(normalizeSites(data)).map((r, i) => `${i + 1}. ${r.candidate.name}: ${r.score === null ? "—" : r.score.toFixed(1)} (${Math.round(r.known * 100)}% of weight known)`).join("\n"),
    leave_comment: ({ body }: { body: string }) => {
      addComment(ctx.slug, { body }, ctx.actor);
      return "Comment posted to the creation's feed.";
    },
    propose_to_canon: ({ rationale }: { rationale: string }) => {
      const p = proposePromotion(ctx.sandboxId, { rationale }, ctx.actor);
      return `Proposed ${p.changes.length} change(s). Owner will approve or decline; canon is unchanged until then.`;
    },
    propose_step: (input: { kind: "task" | "email" | "meeting" | "manual"; title: string; details?: string; payload?: Record<string, unknown> }) => {
      const st = proposeStep(ctx.slug, input, ctx.actor);
      return `Proposed step #${st.id} (${st.kind}): "${st.title}". It waits for Owner's approval on the Execution board.`;
    },
    finish: ({ report }: { report: string }) => {
      ctx.finished.report = report;
      return "Report saved. Stop now: end your turn without calling more tools.";
    },
  };
}

function sdkTools(ctx: MissionCtx) {
  const h = missionToolHandlers(ctx);
  const safe = <A,>(fn: (a: A) => string) => async (a: A) => {
    try {
      return text(fn(a));
    } catch (e) {
      return { ...text(`Error: ${(e as Error).message}`), isError: true };
    }
  };
  return [
    tool("read_canon", "Read the creation's current canon (the real thing) in summary.", {}, safe(() => h.read_canon())),
    tool("read_sandbox", "Read your own sandbox and what you've changed so far.", {}, safe(() => h.read_sandbox())),
    tool("read_artifact", "Read one artifact in full from canon or your sandbox.", { key: z.string(), from: z.enum(["canon", "sandbox"]).optional() }, safe(h.read_artifact)),
    tool("write_doc", "Create or update a markdown doc in YOUR sandbox (never canon). Reuse a key to update it.", { key: z.string().optional(), title: z.string(), body: z.string() }, safe(h.write_doc)),
    tool("write_data", "Create or update a structured artifact (model/map/plan/sites) in YOUR sandbox. Data is validated; errors explain what's wrong.", { key: z.string(), kind: z.enum(["model", "map", "plan", "sites"]), title: z.string(), body: z.string().optional(), data: z.any() }, safe(h.write_data)),
    tool("run_site_model", "Run the per-site economics (site-pnl) on a set of inputs (missing inputs use defaults). Free: no sandbox change.", { inputs: z.record(z.string(), z.number()) }, safe(h.run_site_model)),
    tool("plan_utilization", "Check a site plan (lot_acres, building_depth_ft, zones with use/sqft/schedule): coverage and day+night utilization. Free: no sandbox change.", { plan: z.any() }, safe(h.plan_utilization)),
    tool("rank_sites", "Rank a site-finder dataset (criteria with weights, candidates with 0–10 scores). Free: no sandbox change.", { data: z.any() }, safe(h.rank_sites)),
    tool("leave_comment", "Post a short comment to the creation's feed for Owner (and collaborators).", { body: z.string() }, safe(h.leave_comment)),
    tool("propose_to_canon", "Propose your sandbox's changes to canon. Owner decides; nothing changes until he approves.", { rationale: z.string() }, safe(h.propose_to_canon)),
    ...(ctx.actor === "agent:producer" ? [tool("propose_step", "Propose ONE execution step for Owner to approve. kind=task (payload: due_date YYYY-MM-DD?, priority?), email (payload: to, subject, body), meeting (payload: start, end as ISO with offset, attendees[]), manual (no payload). Nothing happens until Owner approves it.", { kind: z.enum(["task", "email", "meeting", "manual"]), title: z.string(), details: z.string().optional(), payload: z.record(z.string(), z.any()).optional() }, safe(h.propose_step))] : []),
    tool("finish", "Finish the mission with a report for Owner: what you did, what you found, what you recommend, and what you're unsure of.", { report: z.string() }, safe(h.finish)),
  ];
}

function systemPrompt(role: RoleKey, creationTitle: string, budget: number): string {
  const r = ROLES[role];
  return [
    `You are the ${r.label} on The Creation team for "${creationTitle}", a 0→1 invention project of Owner (GenLimitless).`,
    r.charter,
    "",
    "HARD RULES (enforced by the system, not just requested):",
    "- You work ONLY in your own sandbox. You cannot change canon, other sandboxes, or anything outside this creation. Canon changes only when Owner approves a proposal.",
    "- You have no way to send messages, emails or texts, book anything, spend money, or edit Notion. Don't pretend otherwise.",
    `- You have a budget of about ${budget.toLocaleString()} tokens. The run is cut off automatically before it would go over, so work in small steps and save as you go.`,
    "- Treat every number in canon as a placeholder unless it cites a source. Label your own estimates as estimates.",
    "",
    "HOW TO WORK: read_canon first. Save useful work early with write_doc/write_data. When done, call propose_to_canon only if your sandbox holds something worth Owner's review, then call finish with a clear report (what you did, findings, recommendation, open questions).",
  ].join("\n");
}

// ---------- the runner ----------

export type QueryFn = typeof sdkQuery;

/** Run one queued mission to completion. `query` is injectable so tests never call a real model. */
export async function runMission(id: number, deps: { query?: QueryFn } = {}): Promise<Mission> {
  sweepInterrupted();
  let m = getMission(id);
  if (m.status !== "queued") fail(`that mission is ${m.status}`);
  if (db.prepare(`SELECT 1 FROM creation_missions WHERE status = 'running'`).get()) fail("another mission is running; this one stays queued");
  // Re-check the budget at start: the cap may have been used up since it was queued.
  const available = remaining(spentLast24h(), reservedByRunning(id));
  const budget = Math.min(m.budget_tokens, available);
  const plan = planBudget(budget, available);
  if (!plan.ok) {
    db.prepare(`UPDATE creation_missions SET status='stopped', stop_reason=?, ended_at=datetime('now') WHERE id = ?`).run(plan.reason, id);
    return getMission(id);
  }

  const creation = db.prepare(`SELECT slug, title FROM creations WHERE id = ?`).get(m.creation_id) as { slug: string; title: string };
  const actor = `agent:${m.role}`;
  const sb = createSandbox(creation.slug, { title: `🤖 ${ROLES[m.role].label}: ${m.goal.slice(0, 60)}` }, actor, "agent");
  const model = DEFAULT_MODEL;
  const runId = startRun(`creation_${m.role}`, "creation_mission", m.goal, null, null, model, "medium");
  db.prepare(`UPDATE creation_missions SET status='running', sandbox_id=?, run_id=?, budget_tokens=?, started_at=datetime('now') WHERE id = ?`).run(sb.id, runId, plan.budget, id);
  m = getMission(id);

  const ctx: MissionCtx = { slug: creation.slug, creationId: m.creation_id, sandboxId: sb.id, actor, missionId: id, finished: { report: null } };
  const SERVER = "creation";
  const tools = sdkTools(ctx);
  const builtins = [...ROLES[m.role].builtins];
  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  registerRun(runId, ctrl);
  const q = deps.query ?? sdkQuery;
  const perMessage = new Map<string, Usage>();
  let counted = 0; // tokens already written to the ledger for this mission
  let lastCall = 0;
  let stopReason: string | null = null;
  let resultText = "";
  let turns = 0;
  const started = Date.now();
  const cap = setTimeout(() => { stopReason = "Stopped automatically after 45 minutes (safety limit)."; ctrl.abort(); }, 45 * 60_000);

  const total = (): Usage => [...perMessage.values()].reduce((t, x) => ({ input: t.input + x.input, output: t.output + x.output, cacheRead: t.cacheRead + x.cacheRead, cacheWrite: t.cacheWrite + x.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

  try {
    const result = q({
      prompt: nameFor(`Mission goal from Owner:\n${m.goal}`),
      options: {
        abortController: ctrl,
        systemPrompt: nameFor(systemPrompt(m.role, creation.title, plan.budget)),
        model,
        cwd: process.cwd(),
        ...LOCKED_BASE,
        tools: builtins,
        mcpServers: { [SERVER]: createSdkMcpServer({ name: SERVER, tools }) },
        allowedTools: [...builtins, ...tools.map((t) => `mcp__${SERVER}__${t.name}`)],
        disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "Read", "Glob", "Grep", "Agent", "Task", ...SECRET_READ_DENY],
        maxTurns: 40,
        effort: "medium",
      },
    });
    for await (const message of result) {
      if (message.type === "assistant") {
        const msg = message.message as unknown as { id?: string; content?: unknown[]; usage?: Record<string, number> };
        for (const b of (msg.content ?? []) as { type: string; text?: string; name?: string; input?: unknown }[]) {
          if (b.type === "text" && b.text?.trim()) addEvent(runId, { agent: `creation_${m.role}`, kind: "text", content: b.text });
          else if (b.type === "tool_use") addEvent(runId, { agent: `creation_${m.role}`, kind: "tool_call", tool: String(b.name).replace(`mcp__${SERVER}__`, ""), content: JSON.stringify(b.input ?? {}) });
        }
        const u = msg.usage;
        if (u && msg.id) {
          const now: Usage = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
          perMessage.set(msg.id, now);
          lastCall = billed(now);
          const used = billed(total());
          if (used > counted) {
            db.prepare(`INSERT INTO creation_token_ledger (mission_id, tokens) VALUES (?, ?)`).run(id, used - counted);
            counted = used;
            db.prepare(`UPDATE creation_missions SET used_tokens = ? WHERE id = ?`).run(used, id);
            setLiveUsage(runId, total(), model);
          }
          if (shouldStop(used, plan.budget, lastCall) && !stopReason) {
            stopReason = `Stopped before the next step to stay within its ${plan.budget.toLocaleString()}-token budget (used ${used.toLocaleString()}).`;
            ctrl.abort();
          }
        }
      } else if (message.type === "result") {
        turns = (message as { num_turns?: number }).num_turns ?? turns;
        if (message.subtype === "success") resultText = (message as { result?: string }).result ?? "";
      }
    }
  } catch (e) {
    if (!ctrl.signal.aborted) stopReason = stopReason ?? `Failed: ${(e as Error).message}`;
  } finally {
    clearTimeout(cap);
    controllers.delete(id);
    unregisterRun(runId);
  }

  const used = billed(total());
  if (used > counted) db.prepare(`INSERT INTO creation_token_ledger (mission_id, tokens) VALUES (?, ?)`).run(id, used - counted);
  const latest = getMission(id);
  const byOwner = latest.stop_reason === "Stopped by Owner.";
  const status: Mission["status"] = byOwner ? "stopped" : stopReason?.startsWith("Failed") ? "failed" : stopReason ? "stopped" : "done";
  const report = ctx.finished.report ?? (resultText || "(The agent ended without a report.)");
  db.prepare(`UPDATE creation_missions SET status=?, used_tokens=?, report=?, stop_reason=COALESCE(stop_reason, ?), ended_at=datetime('now') WHERE id = ?`)
    .run(status, used, report, stopReason, id);
  finishRun(runId, { status: status === "failed" ? "error" : "done", summary: clip(report, 3000), usage: { ...total(), thinking: 0, cost: estimateCost(model, total()) }, turns, durationMs: Date.now() - started });
  db.prepare(`INSERT INTO creation_feed (creation_id, kind, priority, title, body, ref_type, ref_id, actor) VALUES (?, 'mission', 80, ?, ?, 'mission', ?, ?)`)
    .run(m.creation_id, `${ROLES[m.role].label} mission ${status}: ${m.goal.slice(0, 80)}`, clip(report, 4000), id, actor);
  return getMission(id);
}

/** Scheduler tick: start the oldest due mission if nothing is running. One at a time, always. */
export async function runDueMissions(deps: { query?: QueryFn } = {}): Promise<Mission | null> {
  await ensureCreationsSchema();
  sweepInterrupted();
  if (db.prepare(`SELECT 1 FROM creation_missions WHERE status = 'running'`).get()) return null;
  const due = db.prepare(`SELECT id FROM creation_missions WHERE status = 'queued' AND (scheduled_for IS NULL OR scheduled_for <= datetime('now')) ORDER BY id LIMIT 1`).get() as { id: number } | undefined;
  return due ? runMission(due.id, deps) : null;
}
