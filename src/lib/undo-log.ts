import db, { logIssue } from "./db";
import { backupDatabase } from "./backup";

// Undo log, part 1: RECORDS what an AI chat turn changed (and the before-state needed to reverse it).
// Nothing here reverses anything, and nothing here may ever block, slow down or change a tool call:
// captureBefore / recordAfter never throw. Hooks in agents/runtime.ts call them.

// ---------------------------------------------------------------- schema (additive, backup first)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_turn_runs (
  chat_id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  thread TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_turn_runs_run ON chat_turn_runs(run_id);
CREATE TABLE IF NOT EXISTS undo_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  root_run_id INTEGER NOT NULL,
  agent_slug TEXT,
  tool TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  op TEXT NOT NULL,
  label TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  undoable INTEGER NOT NULL DEFAULT 1,
  not_undoable_reason TEXT,
  state TEXT NOT NULL DEFAULT 'recorded',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  undone_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_undo_actions_root ON undo_actions(root_run_id, id);
CREATE INDEX IF NOT EXISTS idx_undo_actions_entity ON undo_actions(entity, entity_id, id);
`;

let schemaReady: Promise<void> | null = null;

function tablesExist(): boolean {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chat_turn_runs','undo_actions')`).all();
  return rows.length === 2;
}

/** Creates the two tables if missing. A database backup is taken first (CLAUDE.md). */
export function ensureUndoSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      if (!tablesExist()) {
        try {
          await backupDatabase();
        } catch {
          /* backupDatabase logs its own failures */
        }
        db.exec(SCHEMA);
      }
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

const warned = new Set<string>();
function warnOnce(where: string, err: unknown) {
  if (warned.has(where)) return;
  warned.add(where);
  try {
    logIssue("undo_log", `Undo log: ${where} failed (the tool call itself was not affected)`, (err as Error)?.message || String(err));
  } catch {
    /* never throw from logging */
  }
}

/** Top of the parent_run_id chain (the chat turn's run). Max 10 hops. */
export function rootRunId(runId: number): number {
  let cur = runId;
  for (let i = 0; i < 10; i++) {
    const r = db.prepare(`SELECT parent_run_id FROM agent_runs WHERE id=?`).get(cur) as { parent_run_id: number | null } | undefined;
    if (!r || r.parent_run_id == null) break;
    cur = r.parent_run_id;
  }
  return cur;
}

/** Links a chat reply to the run that produced it. Never throws. */
export async function linkChatTurn(chatId: number, runId: number, thread: string | null): Promise<void> {
  try {
    await ensureUndoSchema();
    db.prepare(`INSERT OR IGNORE INTO chat_turn_runs (chat_id, run_id, thread) VALUES (?,?,?)`).run(chatId, runId, thread);
  } catch (err) {
    warnOnce("linkChatTurn", err);
  }
}

// ---------------------------------------------------------------- adapters

type Entity =
  | "page" | "task" | "email_draft" | "text_draft" | "priority" | "learning" | "agent"
  | "scheduled_text" | "calendar_event" | "mail" | "notion_page" | "other";
type Op = "create" | "update" | "move" | "status" | "organize";
type Json = Record<string, any>;

type Adapter = {
  entity: Entity;
  op: Op;
  table?: string;
  key?: string; // primary key column (default id)
  fields?: string[];
  inputId?: (i: Json) => unknown; // existing target, known before the call
  label: (i: Json, snap: Json | null, id: string | null) => string;
  special?: "calendar" | "notion" | "mail";
};

type NotUndoable = { entity: Entity; reason: (id: string | null, i: Json) => string; label: (i: Json) => string };

const PAGE_FIELDS = ["title", "body", "content", "icon", "tags", "summary", "category", "favorite", "link"];
const AGENT_FIELDS = ["name", "objective", "responsibilities", "instructions", "tools", "default_model", "default_effort", "reports_to", "status", "retired_reason"];
const q = (s: unknown, n = 60) => `"${String(s ?? "").replace(/\s+/g, " ").slice(0, n)}"`;

const pageEdit = (verb: string) => (i: Json, s: Json | null, id: string | null) => `${verb} Files page ${q(s?.title ?? i.title ?? `#${id}`)}`;

const ADAPTERS: Record<string, Adapter> = {
  create_page: { entity: "page", op: "create", table: "docs", fields: PAGE_FIELDS, label: (i, s) => `Created Files ${i.kind === "folder" ? "folder" : "page"} ${q(s?.title ?? i.title)}` },
  update_page: { entity: "page", op: "update", table: "docs", fields: PAGE_FIELDS, inputId: (i) => i.page_id, label: pageEdit("Edited") },
  move_page: { entity: "page", op: "move", table: "docs", fields: ["parent_id", "sort_order", "placed_by"], inputId: (i) => i.page_id, label: (_i, s, id) => `Moved Files page #${id}${s?.title ? ` ${q(s.title)}` : ""}` },
  insert_at_mention: { entity: "page", op: "update", table: "docs", fields: PAGE_FIELDS, inputId: (i) => i.page_id, label: pageEdit("Added text to") },

  create_task: { entity: "task", op: "create", table: "tasks", fields: ["title", "notes", "category", "status", "priority", "due_date", "completed_at"], label: (i, s) => `Added task ${q(s?.title ?? i.title)}` },
  update_task: { entity: "task", op: "update", table: "tasks", fields: ["title", "notes", "category", "status", "priority", "due_date", "completed_at"], inputId: (i) => i.task_id, label: (i, s, id) => `Edited task ${q(s?.title ?? i.title ?? `#${id}`)}` },

  create_email_draft: { entity: "email_draft", op: "create", table: "email_drafts", fields: ["to_addr", "subject", "body", "account", "status"], label: (i, s) => `Drafted email ${q(s?.subject ?? i.subject)}` },
  edit_email_draft: { entity: "email_draft", op: "update", table: "email_drafts", fields: ["to_addr", "subject", "body", "account", "status"], inputId: (i) => i.draft_id, label: (_i, s, id) => `Edited email draft ${q(s?.subject ?? `#${id}`)}` },

  draft_text: { entity: "text_draft", op: "create", table: "text_drafts", fields: ["text", "suggested_send_at", "status"], label: (i, s) => `Drafted text ${q(s?.text ?? i.text)}` },
  edit_text_draft: { entity: "text_draft", op: "update", table: "text_drafts", fields: ["text", "suggested_send_at", "status"], inputId: (i) => i.draft_id, label: (_i, s, id) => `Edited text draft ${q(s?.text ?? `#${id}`)}` },

  set_priority: { entity: "priority", op: "update", table: "owner_priorities", fields: ["title", "detail", "rank", "status"], inputId: (i) => i.id, label: (i, s, id) => `${i.id ? "Updated" : "Added"} priority ${q(s?.title ?? i.title ?? `#${id}`)}` },

  record_learning: { entity: "learning", op: "create", table: "agent_learnings", fields: ["lesson", "status", "agent_slug"], label: (i) => `Recorded a lesson for ${i.slug}: ${q(i.lesson, 50)}` },
  retire_learning: { entity: "learning", op: "status", table: "agent_learnings", fields: ["status"], inputId: (i) => i.learning_id, label: (_i, _s, id) => `Retired lesson #${id}` },

  create_agent: { entity: "agent", op: "create", table: "agents", key: "slug", fields: AGENT_FIELDS, label: (i) => `Created agent ${q(i.name ?? i.slug)}` },
  update_agent: { entity: "agent", op: "update", table: "agents", key: "slug", fields: AGENT_FIELDS, inputId: (i) => i.slug, label: (i) => `Edited agent ${q(i.slug)}` },
  retire_agent: { entity: "agent", op: "status", table: "agents", key: "slug", fields: AGENT_FIELDS, inputId: (i) => i.slug, label: (i) => `Retired agent ${q(i.slug)}` },
  restore_agent: { entity: "agent", op: "status", table: "agents", key: "slug", fields: AGENT_FIELDS, inputId: (i) => i.slug, label: (i) => `Restored agent ${q(i.slug)}` },

  schedule_text_owner: { entity: "scheduled_text", op: "create", table: "scheduled_texts", fields: ["message", "send_at", "status"], label: (i) => `Scheduled a text to you ${q(i.message, 50)}` },

  create_calendar_event: { entity: "calendar_event", op: "create", special: "calendar", label: (i) => `Created calendar event ${q(i.summary)}` },
  update_calendar_event: { entity: "calendar_event", op: "update", special: "calendar", inputId: (i) => i.id, label: (i, s) => `Edited calendar event ${q(s?.summary ?? i.summary ?? i.id)}` },
  organize_mail: { entity: "mail", op: "organize", special: "mail", label: (i) => `Mail: ${String(i.action).replace(/_/g, " ")}${i.label ? ` ${q(i.label)}` : ""} on ${(i.message_ids || []).length} message(s)` },
  notion_create_page: { entity: "notion_page", op: "create", special: "notion", label: (i) => `Created Notion page ${q(i.title)}` },
  notion_append: { entity: "notion_page", op: "update", special: "notion", inputId: (i) => i.page, label: (_i, s) => `Added to Notion page ${q(s?.title ?? "")}` },
  notion_update_properties: { entity: "notion_page", op: "update", special: "notion", inputId: (i) => i.page, label: (_i, s) => `Changed properties on Notion page ${q(s?.title ?? "")}` },
};

/** Recorded with undoable=0 and a plain reason, so the confirm dialog can list them. */
const NOT_UNDOABLE: Record<string, NotUndoable> = {
  request_owner_approval: { entity: "other", label: (i) => `Asked you to approve: ${q(i.title)}`, reason: (id) => `Approval request${id ? ` #${id}` : ""}: decide it in Approvals` },
  notion_archive_page: { entity: "other", label: () => `Asked to archive a Notion page`, reason: (id) => `Approval request${id ? ` #${id}` : ""}: decide it in Approvals` },
  delete_task: { entity: "other", label: () => `Asked to delete task(s)`, reason: (id) => `Approval request${id ? ` #${id}` : ""}: decide it in Approvals` },
  cancel_scheduled_text: { entity: "other", label: () => `Asked to cancel a scheduled text`, reason: (id) => `Approval request${id ? ` #${id}` : ""}: decide it in Approvals` },
  propose_fix: { entity: "other", label: (i) => `Proposed a code fix ${q(i.title)}`, reason: () => "Code proposals and PRs can't be undone from chat" },
  open_engineering_issue: { entity: "other", label: (i) => `Opened an engineering issue ${q(i.title)}`, reason: () => "Code proposals and PRs can't be undone from chat" },
  escalate_to_chief_of_staff: { entity: "other", label: (i) => `Escalated ${q(i.title)}`, reason: () => "Escalations can't be undone from chat" },
  text_owner: { entity: "other", label: (i) => `Texted you ${q(i.message, 50)}`, reason: () => "Already delivered to you" },
};

// ---------------------------------------------------------------- helpers

const pick = (row: Json | undefined | null, fields: string[]): Json | null => {
  if (!row) return null;
  const out: Json = {};
  for (const f of fields) if (f in row) out[f] = row[f];
  return out;
};

function readRow(a: Adapter, id: unknown): Json | null {
  if (!a.table || id == null || id === "") return null;
  const row = db.prepare(`SELECT * FROM ${a.table} WHERE ${a.key || "id"}=?`).get(id as any) as Json | undefined;
  return pick(row, a.fields || []);
}

const ID_KEYS = ["page_id", "message_id", "draft_id", "task_id", "learning_id", "priority_id", "id", "slug", "request_id", "approval_id"];
function idFromResult(r: any, depth = 0): string | null {
  if (!r || typeof r !== "object") return null;
  for (const k of ID_KEYS) if (r[k] != null && (typeof r[k] === "number" || typeof r[k] === "string")) return String(r[k]);
  if (depth < 1) for (const v of Object.values(r)) if (v && typeof v === "object" && !Array.isArray(v)) { const n = idFromResult(v, depth + 1); if (n) return n; }
  return null;
}

/** Text of an MCP tool response and whether it is an error. */
function responseParts(resp: any): { text: string | null; isError: boolean } {
  const isError = !!(resp && typeof resp === "object" && !Array.isArray(resp) && resp.isError);
  const blocks: any[] | null = Array.isArray(resp) ? resp : Array.isArray(resp?.content) ? resp.content : null;
  const text = typeof resp === "string" ? resp : blocks ? blocks.map((b) => (b?.type === "text" ? b.text : "")).join("\n") : null;
  return { text, isError };
}

// ---------------------------------------------------------------- capture / record

type Captured = { at: number; before: Json | null; extra?: Json };
const pending = new Map<string, Captured>();
const TTL_MS = 30 * 60_000;

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of pending) if (v.at < cutoff) pending.delete(k);
}

const shortTool = (tool: string) => tool.replace(/^mcp__.+?__/, "");

/** Before a state-changing tool runs: remember the target's current state. Never throws. */
export async function captureBefore(runId: number, tool: string, input: unknown, toolUseId: string | undefined): Promise<void> {
  try {
    const name = shortTool(tool);
    const a = ADAPTERS[name];
    if (!a || !toolUseId) return;
    sweep();
    const i = (input || {}) as Json;
    const cap: Captured = { at: Date.now(), before: null };
    if (a.special === "calendar") {
      if (a.inputId && i.id && i.account) {
        const { getEvent } = await import("./gcal");
        cap.before = JSON.parse(JSON.stringify(await getEvent(i.id, i.account)));
      }
      const { externalAttendees } = await import("./gcal");
      const current = Array.isArray(cap.before?.attendees) ? (cap.before!.attendees as string[]) : [];
      cap.extra = { external: (await externalAttendees([...current, ...(i.attendees || [])])).length > 0 };
    } else if (a.special === "notion") {
      if (a.inputId) {
        const n = await import("./notion");
        const owned = !!n.isOwned(String(i.page));
        cap.extra = { owned };
        if (owned) {
          const names = name === "notion_update_properties" ? Object.keys(JSON.parse(i.properties_json || "{}")) : [];
          cap.before = await n.readWritableProperties(i.page, names);
        }
      }
    } else if (a.special === "mail") {
      cap.before = i.action === "trash" ? null : await (await import("./mail-accounts")).snapshotMailState(i.account, i.message_ids || [], i.label);
    } else if (a.inputId) {
      cap.before = readRow(a, a.inputId(i));
    }
    pending.set(toolUseId, cap);
  } catch (err) {
    warnOnce(`captureBefore(${tool})`, err);
  }
}

function insertAction(runId: number, agentSlug: string | null, tool: string, row: {
  entity: Entity; entity_id: string | null; op: Op; label: string; before: unknown; after: unknown; undoable: boolean; reason?: string | null;
}) {
  db.prepare(
    `INSERT INTO undo_actions (run_id, root_run_id, agent_slug, tool, entity, entity_id, op, label, before_json, after_json, undoable, not_undoable_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    runId,
    rootRunId(runId),
    agentSlug,
    tool,
    row.entity,
    row.entity_id,
    row.op,
    row.label.slice(0, 300),
    row.before == null ? null : JSON.stringify(row.before),
    row.after == null ? null : JSON.stringify(row.after),
    row.undoable ? 1 : 0,
    row.reason ?? null
  );
}

/** After a state-changing tool succeeded: write the undo row(s). Never throws. */
export async function recordAfter(
  runId: number,
  agentSlug: string | null,
  tool: string,
  input: unknown,
  response: unknown,
  toolUseId: string | undefined
): Promise<void> {
  const cap = toolUseId ? pending.get(toolUseId) : undefined;
  if (toolUseId) pending.delete(toolUseId);
  try {
    const name = shortTool(tool);
    const a = ADAPTERS[name];
    const nu = NOT_UNDOABLE[name];
    if (!a && !nu) return;
    const { text, isError } = responseParts(response);
    if (isError) return;
    let result: any = null;
    try {
      result = text ? JSON.parse(text) : null;
    } catch {
      result = null; // not JSON (e.g. a plain message): still record when the target is known from the input
    }
    const i = (input || {}) as Json;
    await ensureUndoSchema();

    if (nu) {
      const id = idFromResult(result);
      insertAction(runId, agentSlug, name, { entity: nu.entity, entity_id: id, op: "create", label: nu.label(i), before: null, after: result && typeof result === "object" ? result : null, undoable: false, reason: nu.reason(id, i) });
      return;
    }
    if (!a) return;

    if (a.special === "calendar") {
      if (cap?.extra?.external) {
        insertAction(runId, agentSlug, name, { entity: "calendar_event", entity_id: i.id ?? null, op: a.op, label: a.label(i, cap.before, null), before: null, after: null, undoable: false, reason: "Invite goes to other people" });
        return;
      }
      if (a.op === "create") {
        insertAction(runId, agentSlug, name, { entity: "calendar_event", entity_id: idFromResult(result), op: "create", label: a.label(i, null, null), before: null, after: result && typeof result === "object" ? { ...result, account: i.account } : null, undoable: false, reason: "Removing an event is a cancellation, so it needs your approval. Cancel it in Calendar, or ask the assistant to request it" });
        return;
      }
      const id = String(i.id ?? "");
      insertAction(runId, agentSlug, name, { entity: "calendar_event", entity_id: id, op: a.op, label: a.label(i, cap?.before ?? null, id), before: cap?.before ?? null, after: result && typeof result === "object" ? { ...result, account: i.account } : null, undoable: true });
      return;
    }
    if (a.special === "mail") {
      if (i.action === "trash") {
        insertAction(runId, agentSlug, name, { entity: "mail", entity_id: null, op: "organize", label: "Asked to move mail to Trash", before: null, after: result, undoable: false, reason: `Approval request${idFromResult(result) ? ` #${idFromResult(result)}` : ""}: decide it in Approvals` });
        return;
      }
      const mailAfter = { account: i.account, message_ids: i.message_ids, action: i.action, label: i.label ?? null };
      if (!cap?.before) {
        insertAction(runId, agentSlug, name, { entity: "mail", entity_id: (i.message_ids || []).join(","), op: "organize", label: a.label(i, null, null), before: null, after: mailAfter, undoable: false, reason: "This mailbox type can't be restored automatically" });
        return;
      }
      insertAction(runId, agentSlug, name, { entity: "mail", entity_id: (i.message_ids || []).join(","), op: "organize", label: a.label(i, null, null), before: cap.before, after: mailAfter, undoable: true });
      return;
    }
    if (a.special === "notion") {
      if (a.op === "update" && cap?.extra && !cap.extra.owned) {
        insertAction(runId, agentSlug, name, { entity: "notion_page", entity_id: String(i.page ?? ""), op: "update", label: `Asked to edit a Notion page`, before: null, after: result, undoable: false, reason: `Approval request${idFromResult(result) ? ` #${idFromResult(result)}` : ""}: decide it in Approvals` });
        return;
      }
      if (name === "notion_append") {
        insertAction(runId, agentSlug, name, { entity: "notion_page", entity_id: String(i.page ?? ""), op: "update", label: a.label(i, cap?.before ?? null, null), before: null, after: result && typeof result === "object" ? result : null, undoable: false, reason: "Text added to a Notion page can't be removed from chat (use the page's history in Notion)" });
        return;
      }
      if (a.op === "create") {
        const id = idFromResult(result);
        insertAction(runId, agentSlug, name, { entity: "notion_page", entity_id: id, op: "create", label: a.label(i, { title: i.title }, id), before: null, after: result && typeof result === "object" ? result : null, undoable: true });
        return;
      }
      const b = cap?.before as Json | null | undefined;
      const pageId = String(i.page ?? "");
      if (!b || b.unsupported?.length) {
        insertAction(runId, agentSlug, name, { entity: "notion_page", entity_id: pageId, op: "update", label: a.label(i, b ?? null, null), before: null, after: result && typeof result === "object" ? result : null, undoable: false, reason: b ? "Notion can't restore these property types automatically: " + b.unsupported.join(", ") : "The earlier values weren't recorded" });
        return;
      }
      let afterProps: Json | null = null;
      try {
        const { readWritableProperties } = await import("./notion");
        afterProps = (await readWritableProperties(pageId, Object.keys(b.props))).props;
      } catch {
        afterProps = null;
      }
      insertAction(runId, agentSlug, name, { entity: "notion_page", entity_id: pageId, op: "update", label: a.label(i, b, null), before: { title: b.title, props: b.props }, after: { ...(result && typeof result === "object" ? result : {}), props: afterProps }, undoable: true });
      return;
    }

    // Plain table-backed tools.
    const id = a.inputId && a.inputId(i) != null && a.inputId(i) !== "" ? String(a.inputId(i)) : idFromResult(result);
    if (id == null) return;
    const afterSnap = readRow(a, id);
    const op: Op = name === "set_priority" && !i.id ? "create" : a.op;
    insertAction(runId, agentSlug, name, { entity: a.entity, entity_id: id, op, label: a.label(i, cap?.before ?? afterSnap, id), before: cap?.before ?? null, after: afterSnap, undoable: true });
  } catch (err) {
    warnOnce(`recordAfter(${tool})`, err);
  }
}
