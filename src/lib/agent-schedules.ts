import db, { logIssue, recordJobRun } from "./db";
import { getAgent } from "./agents/registry";
import { fmtCentral, parseStored, toSqliteUtc } from "./time";
import { describeSpec, dueOccurrence, nextOccurrence } from "./agent-schedules-core";


let ready = false;
function ensure() {
  if (ready) return;
  db.exec(`CREATE TABLE IF NOT EXISTS agent_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    agent_slug TEXT NOT NULL,
    task TEXT NOT NULL,
    dow INTEGER NOT NULL,
    hour INTEGER NOT NULL,
    minute INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_run_key TEXT,
    last_run_at TEXT,
    last_status TEXT,
    last_summary TEXT,
    last_error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    attempt_key TEXT,
    retry_after TEXT
  )`);
  ready = true;
}

let running = false;

async function runOne(row: any, due: { key: string; at: Date }, now: Date) {
  const key = due.key;
  const attempts = row.attempt_key !== key ? 1 : (row.attempts || 0) + 1;
  db.prepare(`UPDATE agent_schedules SET attempts=?, attempt_key=?, last_status='running' WHERE id=?`).run(attempts, key, row.id);
  try {
    if (!getAgent(row.agent_slug)) throw new Error(`agent ${row.agent_slug} not found`);
    const out = String(await (await import("./agents/runtime")).runAssignment(row.agent_slug, row.task, "scheduled", 30));
    db.prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant', ?)`).run(
      `**Weekly report: ${row.agent_slug} (scheduled ${fmtCentral(due.at)})**\n\n${out}`
    );
    recordJobRun(`agent_schedule:${row.id}`, key, "done");
    db.prepare(
      `UPDATE agent_schedules SET last_run_key=?, last_run_at=datetime('now'), last_status='done', last_summary=?, last_error=NULL WHERE id=?`
    ).run(key, out.slice(0, 500), row.id);
  } catch (err: any) {
    const message = String(err?.message || err);
    db.prepare(`UPDATE agent_schedules SET last_status='failed', last_error=?, retry_after=? WHERE id=?`).run(
      message,
      toSqliteUtc(new Date(now.getTime() + 30 * 60e3)),
      row.id
    );
    if (attempts >= 3) {
      logIssue("scheduler:agent_schedules", `Scheduled run of ${row.agent_slug} failed 3 times`, message);
      db.prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant', ?)`).run(
        `**Weekly report: ${row.agent_slug} did not run.** The scheduled run (${fmtCentral(due.at)}) failed 3 times. Reason: ${message}`
      );
    }
  }
}

export async function runAgentSchedulesTick(reason: string) {
  if (running) return;
  running = true;
  try {
    ensure();
    const rows = db.prepare(`SELECT * FROM agent_schedules WHERE enabled=1`).all() as any[];
    for (const row of rows) {
      const now = new Date();
      const created = parseStored(row.created_at) || now;
      const due = dueOccurrence({ dow: row.dow, hour: row.hour, minute: row.minute }, now, created, row.last_run_key);
      if (!due) continue;
      if (row.attempt_key === due.key && row.attempts >= 3) continue;
      if (row.attempt_key === due.key && row.retry_after && row.retry_after > toSqliteUtc(now)) continue;
      await runOne(row, due, now);
    }
  } finally {
    running = false;
  }
}

export function listAgentSchedules() {
  ensure();
  const rows = db.prepare(`SELECT * FROM agent_schedules ORDER BY id`).all() as any[];
  return rows.map((r) => {
    const next = nextOccurrence({ dow: r.dow, hour: r.hour, minute: r.minute });
    return {
      ...r,
      description: describeSpec({ dow: r.dow, hour: r.hour, minute: r.minute }),
      nextRunAt: next ? next.at.toISOString() : null,
      nextRunLabel: next ? fmtCentral(next.at) : "",
      agentFound: !!getAgent(r.agent_slug),
    };
  });
}

export function setAgentScheduleEnabled(id: number, enabled: boolean) {
  ensure();
  db.prepare(`UPDATE agent_schedules SET enabled=? WHERE id=?`).run(enabled ? 1 : 0, id);
}
