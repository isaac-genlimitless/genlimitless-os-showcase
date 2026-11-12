import db from "../db";
import { CORE_AGENTS } from "./charters";
import { isOwnerCell, nameFor } from "../instance";
import { backupDatabase } from "../backup";
import { assertModelAllowed, validateModelEffort } from "../model-policy";

// The agent org chart, stored so the Chief of Staff (and Owner) can change it at runtime:
// who exists, what each one is for, their editable operating instructions, what they've
// learned, and an audit trail of every change. Nothing here is ever hard-deleted: agents
// are retired (reversible), learnings are retired, and every edit keeps its before/after.

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom',        -- core | custom
  reports_to TEXT,                            -- slug of manager; NULL only for chief_of_staff
  objective TEXT NOT NULL,                    -- the end result this agent is accountable for
  responsibilities TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',      -- operating instructions the CoS or Owner can edit
  tools TEXT NOT NULL DEFAULT '[]',           -- JSON tool names (custom agents; core agents' tools are fixed in code)
  status TEXT NOT NULL DEFAULT 'active',      -- active | retired
  created_by TEXT NOT NULL DEFAULT 'system',  -- system | chief_of_staff | owner
  retired_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_slug TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  field TEXT NOT NULL,
  before TEXT,
  after TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_slug TEXT NOT NULL,
  lesson TEXT NOT NULL,
  source TEXT NOT NULL,                       -- owner | chief_of_staff | self | owner_edit
  status TEXT NOT NULL DEFAULT 'active',      -- active | retired | raw (unprocessed signal, e.g. an Owner edit)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  severity TEXT NOT NULL,                     -- critical | important | fyi
  kind TEXT NOT NULL,                         -- message | problem | solution | report | decision | access
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open',        -- open | handled
  cos_note TEXT,
  notified_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  handled_at TEXT
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_by TEXT NOT NULL,
  action TEXT NOT NULL,                       -- discard_draft | discard_text_draft | other
  target_id INTEGER,
  title TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | declined
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_slug TEXT NOT NULL,
  trigger TEXT NOT NULL,                      -- chat | inbound_sweep | ops_review | briefing | ...
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS owner_priorities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'active',      -- active | done | dropped
  rank INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

{
  // Per-agent model/effort defaults (NULL = use the trigger rules in model-policy.ts). Additive only.
  const cols = (db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[]).map((c) => c.name);
  const missing = ["default_model", "default_effort"].filter((c) => !cols.includes(c));
  if (missing.length) {
    backupDatabase().catch(() => {}); // snapshot first (CLAUDE.md); failures are logged by backupDatabase
    for (const c of missing) db.exec(`ALTER TABLE agents ADD COLUMN ${c} TEXT`);
  }
}

{
  // Give the page-writing custom agents the page tools (which carry `link`). Add-only, idempotent.
  const need = ["create_page", "update_page"];
  const rows = db.prepare(`SELECT slug, tools FROM agents WHERE slug IN ('doc_writer','research_strategist','research_scout') AND kind = 'custom'`).all() as { slug: string; tools: string }[];
  for (const r of rows) {
    let list: unknown;
    try { list = JSON.parse(r.tools || "[]"); } catch { continue; }
    if (!Array.isArray(list)) continue;
    const add = need.filter((t) => !list.includes(t));
    if (add.length) db.prepare(`UPDATE agents SET tools = ?, updated_at = datetime('now') WHERE slug = ?`).run(JSON.stringify([...list, ...add]), r.slug);
  }
}

{
  // Give the Doc Writer the integration doc tools. Add-only, idempotent; skips if missing or malformed.
  const need = ["get_job_application_docs", "update_job_application_docs"];
  const r = db.prepare(`SELECT slug, tools FROM agents WHERE slug = 'doc_writer' AND kind = 'custom'`).get() as { slug: string; tools: string } | undefined;
  if (r) {
    let list: unknown;
    try { list = JSON.parse(r.tools || "[]"); } catch { list = null; }
    if (Array.isArray(list)) {
      const add = need.filter((t) => !list.includes(t));
      if (add.length) db.prepare(`UPDATE agents SET tools = ?, updated_at = datetime('now') WHERE slug = ?`).run(JSON.stringify([...list, ...add]), r.slug);
    }
  }
}

{
  // Give the Doc Writer the create_job_application tool. Add-only, idempotent; skips if missing or malformed.
  const need = ["create_job_application"];
  const r = db.prepare(`SELECT slug, tools FROM agents WHERE slug = 'doc_writer' AND kind = 'custom'`).get() as { slug: string; tools: string } | undefined;
  if (r) {
    let list: unknown;
    try { list = JSON.parse(r.tools || "[]"); } catch { list = null; }
    if (Array.isArray(list)) {
      const add = need.filter((t) => !list.includes(t));
      if (add.length) db.prepare(`UPDATE agents SET tools = ?, updated_at = datetime('now') WHERE slug = ?`).run(JSON.stringify([...list, ...add]), r.slug);
    }
  }
}

{
  // Give the Research Scout the integration submit tool. Add-only, idempotent; skips if missing or malformed.
  const need = ["job_engine_add_job", "job_engine_get_instructions", "job_engine_update_instructions"];
  const r = db.prepare(`SELECT slug, tools FROM agents WHERE slug = 'research_scout' AND kind = 'custom'`).get() as { slug: string; tools: string } | undefined;
  if (r) {
    let list: unknown;
    try { list = JSON.parse(r.tools || "[]"); } catch { list = null; }
    if (Array.isArray(list)) {
      const add = need.filter((t) => !list.includes(t));
      if (add.length) db.prepare(`UPDATE agents SET tools = ?, updated_at = datetime('now') WHERE slug = ?`).run(JSON.stringify([...list, ...add]), r.slug);
    }
  }
}

export type AgentRow = {
  default_model: string | null;
  default_effort: string | null;
  slug: string;
  name: string;
  kind: "core" | "custom";
  reports_to: string | null;
  objective: string;
  responsibilities: string;
  instructions: string;
  tools: string;
  status: "active" | "retired";
  created_by: string;
  retired_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type Learning = { id: number; agent_slug: string; lesson: string; source: string; status: string; created_at: string };

// Core agents are inserted once; after that their objective/responsibilities/instructions
// live in the DB so the CoS and Owner can tune them without a code change.
// The Full Stack Engineer builds and fixes the shared OS code, so it exists only in the owner cell (docs/multi-user.md
// "Member mode"); a member cell that already has it (created before this rule) has it retired, which is reversible.
for (const a of Object.values(CORE_AGENTS)) {
  if (!isOwnerCell() && a.slug === "full_stack_engineer") continue;
  db.prepare(
    `INSERT OR IGNORE INTO agents (slug, name, kind, reports_to, objective, responsibilities, instructions, created_by)
     VALUES (?, ?, 'core', ?, ?, ?, ?, 'system')`
  ).run(a.slug, a.name, a.reports_to, a.objective, a.responsibilities, a.instructions);
}
if (!isOwnerCell()) {
  db.prepare(
    `UPDATE agents SET status='retired', retired_reason='The Full Stack Engineer works on the shared OS code: owner only.', updated_at=datetime('now')
     WHERE slug='full_stack_engineer' AND status != 'retired'`
  ).run();
}

// The Marketing Director ran school outreach and campaigns, which Owner no longer does. Retire it
// (reversible, history kept; nothing is deleted). Chief drafts and triages everything directly now.
db.prepare(
  `UPDATE agents SET status='retired', retired_reason='School outreach and campaigns were removed; Chief handles drafting and triage directly.', updated_at=datetime('now')
   WHERE slug='marketing_director' AND status != 'retired'`
).run();

const SLUG_RE = /^[a-z][a-z0-9_]{2,39}$/;

// Core agents' display name comes from code at read time (no DB write).
function withCoreName(row: AgentRow): AgentRow {
  const core = (CORE_AGENTS as Record<string, { name: string } | undefined>)[row.slug];
  const r = row.kind === "core" && core ? { ...row, name: core.name } : row;
  // Member cells: the seeded charters say "Owner"; show/use the cell user's name instead (no DB write).
  return { ...r, objective: nameFor(r.objective), responsibilities: nameFor(r.responsibilities), instructions: nameFor(r.instructions) };
}

export function listAgents(includeRetired = false): AgentRow[] {
  return (
    db
      .prepare(
        `SELECT * FROM agents ${includeRetired ? "" : "WHERE status = 'active'"}
       ORDER BY CASE kind WHEN 'core' THEN 0 ELSE 1 END, created_at ASC`
      )
      .all() as AgentRow[]
  ).map(withCoreName);
}

export function getAgent(slug: string): AgentRow | undefined {
  const row = db.prepare(`SELECT * FROM agents WHERE slug = ?`).get(slug) as AgentRow | undefined;
  return row ? withCoreName(row) : undefined;
}

function recordChange(slug: string, by: string, field: string, before: unknown, after: unknown, reason?: string) {
  db.prepare(
    `INSERT INTO agent_changes (agent_slug, changed_by, field, before, after, reason) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(slug, by, field, before == null ? null : String(before), after == null ? null : String(after), reason || null);
}

export function createAgent(input: {
  slug: string;
  name: string;
  objective: string;
  responsibilities: string;
  instructions: string;
  tools: string[];
  reports_to?: string;
  created_by: "chief_of_staff" | "owner";
  reason: string;
}): AgentRow {
  if (!SLUG_RE.test(input.slug)) throw new Error("slug must be lowercase letters, digits and underscores (3-40 chars)");
  const existing = getAgent(input.slug);
  if (existing?.status === "active") throw new Error(`An active agent '${input.slug}' already exists`);
  if (existing?.kind === "core") throw new Error(`'${input.slug}' is a core agent`);
  const manager = input.reports_to || "chief_of_staff";
  if (!getAgent(manager)) throw new Error(`reports_to '${manager}' is not an agent`);

  if (existing) {
    // Reusing a retired custom agent's slug revives it with the new definition.
    db.prepare(
      `UPDATE agents SET name=?, reports_to=?, objective=?, responsibilities=?, instructions=?, tools=?, status='active',
       retired_reason=NULL, created_by=?, updated_at=datetime('now') WHERE slug=?`
    ).run(input.name, manager, input.objective, input.responsibilities, input.instructions, JSON.stringify(input.tools), input.created_by, input.slug);
  } else {
    db.prepare(
      `INSERT INTO agents (slug, name, kind, reports_to, objective, responsibilities, instructions, tools, created_by)
       VALUES (?, ?, 'custom', ?, ?, ?, ?, ?, ?)`
    ).run(input.slug, input.name, manager, input.objective, input.responsibilities, input.instructions, JSON.stringify(input.tools), input.created_by);
  }
  recordChange(input.slug, input.created_by, "created", null, input.objective, input.reason);
  return getAgent(input.slug)!;
}

const EDITABLE = ["name", "objective", "responsibilities", "instructions", "tools", "default_model", "default_effort"] as const;
type Editable = (typeof EDITABLE)[number];

export function updateAgent(
  slug: string,
  changes: Partial<Record<Editable, string | string[] | null>>,
  changedBy: string,
  reason: string
): AgentRow {
  const agent = getAgent(slug);
  if (!agent) throw new Error(`No agent '${slug}'`);
  // "" clears a default (back to the trigger rules). Validate everything before writing anything.
  for (const f of ["default_model", "default_effort"] as const) if (changes[f] === "") changes[f] = null;
  if (changes.default_model !== undefined || changes.default_effort !== undefined) {
    const model = changes.default_model !== undefined ? (changes.default_model as string | null) : agent.default_model;
    const effort = changes.default_effort !== undefined ? (changes.default_effort as string | null) : agent.default_effort;
    validateModelEffort(model, effort);
    if (model === "claude-haiku-4-5" && effort) throw new Error("Haiku 4.5 has no effort setting; clear the default effort first.");
    assertModelAllowed(model || "", slug, "default");
  }
  if (changes.tools !== undefined && agent.kind === "core")
    throw new Error("Core agents' tool access is fixed in code; ask the Full Stack Engineer for a code change instead");
  if (changes.name !== undefined && agent.kind === "core") throw new Error("Core agents can't be renamed");
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const field of EDITABLE) {
    const v = changes[field];
    if (v === undefined) continue;
    const value = Array.isArray(v) ? JSON.stringify(v) : v;
    if (value === (agent as any)[field]) continue;
    sets.push(`${field} = ?`);
    vals.push(value);
    recordChange(slug, changedBy, field, (agent as any)[field], value, reason);
  }
  if (sets.length) db.prepare(`UPDATE agents SET ${sets.join(", ")}, updated_at=datetime('now') WHERE slug=?`).run(...vals, slug);
  return getAgent(slug)!;
}

/** Soft retire: the agent stops being available but its definition, history and learnings stay. */
export function retireAgent(slug: string, changedBy: string, reason: string) {
  const agent = getAgent(slug);
  if (!agent) throw new Error(`No agent '${slug}'`);
  if (agent.kind === "core") throw new Error("Core agents can't be retired");
  if (agent.status === "retired") return agent;
  db.prepare(`UPDATE agents SET status='retired', retired_reason=?, updated_at=datetime('now') WHERE slug=?`).run(reason, slug);
  // Anyone reporting to the retired agent moves up to the Chief of Staff.
  db.prepare(`UPDATE agents SET reports_to='chief_of_staff' WHERE reports_to=?`).run(slug);
  recordChange(slug, changedBy, "status", "active", "retired", reason);
  return getAgent(slug)!;
}

export function restoreAgent(slug: string, changedBy: string, reason: string) {
  const agent = getAgent(slug);
  if (!agent) throw new Error(`No agent '${slug}'`);
  db.prepare(`UPDATE agents SET status='active', retired_reason=NULL, updated_at=datetime('now') WHERE slug=?`).run(slug);
  recordChange(slug, changedBy, "status", agent.status, "active", reason);
  return getAgent(slug)!;
}

export function agentChanges(slug?: string, limit = 50) {
  return slug
    ? db.prepare(`SELECT * FROM agent_changes WHERE agent_slug=? ORDER BY id DESC LIMIT ?`).all(slug, limit)
    : db.prepare(`SELECT * FROM agent_changes ORDER BY id DESC LIMIT ?`).all(limit);
}

// ---------- Learnings: how each agent adapts to Owner over time ----------

export function addLearning(slug: string, lesson: string, source: string, status: "active" | "raw" = "active") {
  if (!getAgent(slug)) throw new Error(`No agent '${slug}'`);
  const dup = db
    .prepare(`SELECT id FROM agent_learnings WHERE agent_slug=? AND lesson=? AND status='active'`)
    .get(slug, lesson) as { id: number } | undefined;
  if (dup) return { learning_id: dup.id, duplicate: true };
  const r = db
    .prepare(`INSERT INTO agent_learnings (agent_slug, lesson, source, status) VALUES (?, ?, ?, ?)`)
    .run(slug, lesson, source, status);
  return { learning_id: Number(r.lastInsertRowid) };
}

export function listLearnings(slug: string, status: "active" | "raw" = "active"): Learning[] {
  return db
    .prepare(`SELECT * FROM agent_learnings WHERE agent_slug=? AND status=? ORDER BY id ASC`)
    .all(slug, status) as Learning[];
}

export function setLearningStatus(id: number, status: "active" | "retired", changedBy: string, reason: string) {
  const row = db.prepare(`SELECT * FROM agent_learnings WHERE id=?`).get(id) as Learning | undefined;
  if (!row) throw new Error(`No learning ${id}`);
  db.prepare(`UPDATE agent_learnings SET status=? WHERE id=?`).run(status, id);
  recordChange(row.agent_slug, changedBy, `learning#${id}`, row.status, status, reason);
  return { learning_id: id, status };
}

// ---------- Escalations: agents -> Chief of Staff ----------

export type Escalation = {
  id: number;
  from_agent: string;
  severity: "critical" | "important" | "fyi";
  kind: string;
  title: string;
  detail: string | null;
  status: "open" | "handled";
  cos_note: string | null;
  notified_owner: number;
  created_at: string;
  handled_at: string | null;
};

export function createEscalation(input: {
  from_agent: string;
  severity: Escalation["severity"];
  kind: string;
  title: string;
  detail?: string;
}) {
  const dup = db
    .prepare(`SELECT id FROM escalations WHERE status='open' AND from_agent=? AND title=?`)
    .get(input.from_agent, input.title) as { id: number } | undefined;
  if (dup) return { escalation_id: dup.id, duplicate: true };
  const r = db
    .prepare(`INSERT INTO escalations (from_agent, severity, kind, title, detail) VALUES (?, ?, ?, ?, ?)`)
    .run(input.from_agent, input.severity, input.kind, input.title, input.detail || null);
  return { escalation_id: Number(r.lastInsertRowid) };
}

export function listEscalations(status: "open" | "handled" | "all" = "open", limit = 50): Escalation[] {
  return (
    status === "all"
      ? db.prepare(`SELECT * FROM escalations ORDER BY id DESC LIMIT ?`).all(limit)
      : db.prepare(`SELECT * FROM escalations WHERE status=? ORDER BY id DESC LIMIT ?`).all(status, limit)
  ) as Escalation[];
}

export function handleEscalation(id: number, note: string, notifiedOwner = false) {
  db.prepare(
    `UPDATE escalations SET status='handled', cos_note=?, notified_owner=MAX(notified_owner, ?), handled_at=datetime('now') WHERE id=?`
  ).run(note, notifiedOwner ? 1 : 0, id);
  return { escalation_id: id, status: "handled" };
}

// ---------- Approval requests: anything destructive waits for Owner ----------

{
  const cols = (db.prepare(`PRAGMA table_info(approval_requests)`).all() as { name: string }[]).map((c) => c.name);
  // JSON describing exactly what runs on approval (e.g. the calendar event to create).
  if (!cols.includes("payload")) db.exec(`ALTER TABLE approval_requests ADD COLUMN payload TEXT`);
  if (!cols.includes("result")) db.exec(`ALTER TABLE approval_requests ADD COLUMN result TEXT`);
}

export type ApprovalAction =
  | "discard_draft"
  | "discard_text_draft"
  | "discard_email_draft"
  | "archive_page"
  | "trash_mail"
  | "calendar_create"
  | "calendar_update"
  | "calendar_cancel"
  | "notion_edit"
  | "notion_archive"
  | "cancel_scheduled_text"
  | "delete_task"
  | "deactivate_user"
  | "change_user_role"
  | "remove_user"
  | "other";

export type ApprovalRequest = {
  id: number;
  requested_by: string;
  action: ApprovalAction;
  target_id: number | null;
  title: string;
  reason: string | null;
  status: "pending" | "approved" | "declined" | "failed";
  payload: string | null;
  result: string | null;
  created_at: string;
  decided_at: string | null;
};

export function createApprovalRequest(input: {
  requested_by: string;
  action: ApprovalRequest["action"];
  target_id?: number;
  title: string;
  reason: string;
  payload?: unknown;
}) {
  const dup = db
    .prepare(`SELECT id FROM approval_requests WHERE status='pending' AND action=? AND COALESCE(target_id,-1)=? AND title=?`)
    .get(input.action, input.target_id ?? -1, input.title) as { id: number } | undefined;
  if (dup) return { request_id: dup.id, duplicate: true };
  const r = db
    .prepare(`INSERT INTO approval_requests (requested_by, action, target_id, title, reason, payload) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(input.requested_by, input.action, input.target_id ?? null, input.title, input.reason, input.payload === undefined ? null : JSON.stringify(input.payload));
  return { request_id: Number(r.lastInsertRowid), status: "pending", note: "Waiting for Owner under Team → Needs your approval." };
}

export function listApprovalRequests(status: ApprovalRequest["status"] | "all" = "pending"): ApprovalRequest[] {
  return (
    status === "all"
      ? db.prepare(`SELECT * FROM approval_requests ORDER BY id DESC LIMIT 100`).all()
      : db.prepare(`SELECT * FROM approval_requests WHERE status=? ORDER BY id DESC LIMIT 100`).all(status)
  ) as ApprovalRequest[];
}

export function getApprovalRequest(id: number): ApprovalRequest | undefined {
  return db.prepare(`SELECT * FROM approval_requests WHERE id=?`).get(id) as ApprovalRequest | undefined;
}

export function markApprovalDecided(id: number, status: "approved" | "declined" | "failed", result?: string) {
  db.prepare(`UPDATE approval_requests SET status=?, result=?, decided_at=datetime('now') WHERE id=? AND status='pending'`).run(status, result ?? null, id);
}

// ---------- Activity log: what each agent did, so the CoS can oversee ----------

export function logActivity(slug: string, trigger: string, summary: string) {
  db.prepare(`INSERT INTO agent_activity (agent_slug, trigger, summary) VALUES (?, ?, ?)`).run(slug, trigger, summary.slice(0, 4000));
}

export function recentActivity(hours = 24, slug?: string) {
  return slug
    ? db
        .prepare(`SELECT * FROM agent_activity WHERE agent_slug=? AND created_at > datetime('now', ?) ORDER BY id DESC LIMIT 100`)
        .all(slug, `-${hours} hours`)
    : db
        .prepare(`SELECT * FROM agent_activity WHERE created_at > datetime('now', ?) ORDER BY id DESC LIMIT 100`)
        .all(`-${hours} hours`);
}

// ---------- Owner's priorities: what the CoS keeps him focused on ----------

export type Priority = { id: number; title: string; detail: string | null; status: string; rank: number; created_at: string; updated_at: string };

export function listPriorities(includeClosed = false): Priority[] {
  return db
    .prepare(`SELECT * FROM owner_priorities ${includeClosed ? "" : "WHERE status='active'"} ORDER BY rank ASC, id ASC`)
    .all() as Priority[];
}

export function setPriority(input: { id?: number; title?: string; detail?: string; rank?: number; status?: "active" | "done" | "dropped" }) {
  if (input.id) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const k of ["title", "detail", "rank", "status"] as const) {
      if (input[k] !== undefined) {
        sets.push(`${k}=?`);
        vals.push(input[k]);
      }
    }
    if (!sets.length) throw new Error("Nothing to change");
    db.prepare(`UPDATE owner_priorities SET ${sets.join(", ")}, updated_at=datetime('now') WHERE id=?`).run(...vals, input.id);
    return { priority_id: input.id };
  }
  if (!input.title) throw new Error("title is required for a new priority");
  const r = db
    .prepare(`INSERT INTO owner_priorities (title, detail, rank) VALUES (?, ?, ?)`)
    .run(input.title, input.detail || null, input.rank ?? 100);
  return { priority_id: Number(r.lastInsertRowid) };
}
