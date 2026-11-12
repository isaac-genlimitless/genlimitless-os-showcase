import db from "./db";
import { retryReady, currentMainOid, type GuardDeps } from "./fix-retry-guard";

// Automatic recovery of failed fix builds. Additive: never deletes, never edits a proposal's text.
// Retries copy the original text verbatim (no widening of scope) and respect the approval guardrail.

export type FailKind = "usage_limit" | "transient" | "policy" | "typecheck" | "other";
export const MAX_RETRIES = 2;
const APPROVED = "[Chief of Staff: approve]";
const ESCALATED_MARK = "[Owner alerted: retries exhausted]";

const USAGE_RE = /usage limit|rate limit|session limit|\b529\b|overloaded|resets? at/i;
const TRANSIENT_RE = /couldn't fetch|couldn't make a working copy|couldn't push|couldn't be opened|couldn't commit|\bgit\b[^.\n]*(fatal|error)|\bgh\b[^.\n]*error|ETIMEDOUT|ECONNRESET|timed out|ran longer than/i;
const POLICY_RE = /package(-lock)?\.json|needs new packages|new (dependency|package)|\.github\/|was deleted|deleted or gutted|was emptied|mostly removed/i;
const TYPECHECK_RE = /type-check|typecheck|error TS\d+/i;

/** Parse "resets at 3pm" / "resets 3:30 PM" / ISO-ish time into a Date (next occurrence), else null. */
export function parseResetTime(text: string, now: Date = new Date()): Date | null {
  const iso = text.match(/resets?(?: at)?\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i);
  if (iso) {
    const d = new Date(iso[1]);
    if (!isNaN(d.getTime())) return d;
  }
  const m = text.match(/resets?(?: at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") h += 12;
  const d = new Date(now);
  d.setHours(h, Number(m[2] || 0), 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/** Classify a failure from its message text. Order matters: a usage limit beats everything. */
export function classifyFailure(text: string, now: Date = new Date()): { kind: FailKind; retryAfter: string | null } {
  if (USAGE_RE.test(text)) {
    const reset = parseResetTime(text, now) ?? new Date(now.getTime() + 60 * 60_000);
    return { kind: "usage_limit", retryAfter: reset.toISOString() };
  }
  if (POLICY_RE.test(text)) return { kind: "policy", retryAfter: null };
  if (TYPECHECK_RE.test(text)) return { kind: "typecheck", retryAfter: null };
  if (TRANSIENT_RE.test(text)) return { kind: "transient", retryAfter: null };
  return { kind: "other", retryAfter: null };
}

type Row = {
  id: number;
  issue_id: number | null;
  title: string;
  diagnosis: string;
  proposed_change: string;
  files: string | null;
  kind: string;
  size: string | null;
  size_reasons: string | null;
  repo: string | null;
  proposed_by: string | null;
  cos_review: string | null;
  result: string | null;
  fail_kind: string | null;
  retry_of: number | null;
  retry_count: number | null;
};

type Deps = {
  database?: { prepare: (sql: string) => any };
  now?: Date;
  /** Main's current commit oid (default: git rev-parse origin/main). */
  mainOid?: string | null;
  guard?: GuardDeps;
  /** Starts the build for an approved row (default: the existing ops.ts apply path). */
  enqueue?: (id: number) => Promise<unknown> | void;
  /** Alerts Owner (default: the existing escalation helper). */
  escalate?: (input: { from_agent: string; severity: "important"; kind: string; title: string; detail: string }) => unknown;
};

function chainIds(database: Deps["database"] & object, row: Row): number[] {
  const ids: number[] = [row.id];
  let cur: Row | undefined = row;
  while (cur && cur.retry_of) {
    ids.unshift(cur.retry_of);
    cur = database.prepare(`SELECT * FROM fix_proposals WHERE id=?`).get(cur.retry_of) as Row | undefined;
  }
  return ids;
}

export function retryFailedFixes(deps: Deps = {}): { retried: number[]; escalated: number[] } {
  const database = deps.database ?? db;
  const now = deps.now ?? new Date();
  const out = { retried: [] as number[], escalated: [] as number[] };
  const failed = database.prepare(`SELECT * FROM fix_proposals WHERE status='failed' ORDER BY id`).all() as Row[];

  for (const row of failed) {
    const count = row.retry_count ?? 0;
    const already = database.prepare(`SELECT id FROM fix_proposals WHERE retry_of=?`).get(row.id) as { id: number } | undefined;
    if (already) continue;

    if (count >= MAX_RETRIES) {
      if ((row.result ?? "").includes(ESCALATED_MARK)) continue;
      const ids = chainIds(database, row);
      const detail = `Original #${ids[0]}; chain: ${ids.map((i) => `#${i}`).join(" → ")}; fail kind: ${row.fail_kind ?? "unknown"}.\n\nLast result:\n${(row.result ?? "").slice(0, 1500)}`;
      const esc =
        deps.escalate ??
        ((input) => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require avoids a circular import
          const { createEscalation } = require("./agents/registry") as typeof import("./agents/registry");
          return createEscalation(input);
        });
      esc({ from_agent: "full_stack_engineer", severity: "important", kind: "fix_retries_exhausted", title: `Fix #${ids[0]} failed after ${MAX_RETRIES} automatic retries`, detail });
      database.prepare(`UPDATE fix_proposals SET result=COALESCE(result||char(10)||char(10),'')||? WHERE id=?`).run(ESCALATED_MARK, row.id);
      out.escalated.push(row.id);
      continue;
    }

    const retryAfter = (database.prepare(`SELECT retry_after FROM fix_proposals WHERE id=?`).get(row.id) as { retry_after: string | null }).retry_after;
    if (retryAfter && new Date(retryAfter).getTime() > now.getTime()) continue;
    // Wait (row stays failed, re-checked next tick) until parents are merged and main has moved on.
    if (!retryReady(row, deps.mainOid !== undefined ? deps.mainOid : currentMainOid(), deps.guard)) continue;

    const kind = (row.fail_kind as FailKind | null) ?? "other";
    const n = count + 1;
    const origin = chainIds(database, row)[0];
    const insert = (title: string, diagnosis: string, status: string) =>
      Number(
        database
          .prepare(
            `INSERT INTO fix_proposals (issue_id, title, diagnosis, proposed_change, files, status, kind, size, size_reasons, proposed_by, repo, cos_review, retry_of, retry_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(row.issue_id, title, diagnosis, row.proposed_change, row.files, status, row.kind, row.size, row.size_reasons, row.proposed_by, row.repo, status === "pending_cos_review" ? null : row.cos_review, row.id, n).lastInsertRowid
      );

    let newId: number;
    if (kind === "policy" || kind === "typecheck") {
      // Deterministic failure: don't blind-retry. Route back through review as a revision, with the real reason.
      newId = insert(
        `${row.title} (revise #${row.id}; auto-retry ${n}/${MAX_RETRIES} of #${origin})`,
        `${row.diagnosis}\n\nRevise #${row.id}: it failed (${kind}). Reason from the build:\n${(row.result ?? "").slice(0, 3000)}`,
        "pending_cos_review"
      );
    } else {
      // A failed row already went through the approval gate in ops.ts (only Owner can apply a major one),
      // so an on-record approval is reused. Without one, the retry waits as pending_approval for Owner.
      const approved = (row.cos_review ?? "").startsWith(APPROVED);
      const minor = row.size === "minor";
      newId = insert(
        `${row.title} (auto-retry ${n}/${MAX_RETRIES} of #${origin})`,
        row.diagnosis,
        approved && minor ? "cos_approved" : "pending_approval"
      );
      if (approved) {
        const go = deps.enqueue ?? (async (id: number) => { await (await import("./ops")).applyFixProposal(id, minor ? "chief_of_staff" : "owner"); });
        Promise.resolve()
          .then(() => go(newId))
          .catch((e: any) => console.error(`auto-retry of fix #${row.id} failed to start`, e?.message));
      }
    }
    database.prepare(`UPDATE fix_proposals SET result=COALESCE(result,'')||? WHERE id=?`).run(` → retried as #${newId}`, row.id);
    out.retried.push(newId);
  }
  return out;
}
