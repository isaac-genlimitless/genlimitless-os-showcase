import { test, expect } from "./isolated-test";
import { logIssueOnce } from "../src/lib/issue-once";
import { openTestDb } from "./db-handle";

// logIssueOnce must dedupe identical OPEN issues (same source + message), log again for a
// different message, and log again once the earlier one is resolved. Pure DB test: never sends
// anything or runs an agent.

const SOURCE = "e2e:issue-once";

function cleanup() {
  const db = openTestDb();
  try {
    db.prepare(`DELETE FROM issues WHERE source = ?`).run(SOURCE);
  } finally {
    db.close();
  }
}

function openCount(message: string): number {
  const db = openTestDb();
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM issues WHERE source = ? AND message = ? AND status = 'open'`)
      .get(SOURCE, message) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

test("logIssueOnce logs once per distinct open message", async () => {
  cleanup();
  const stamp = Date.now();
  const msgA = `Pre-existing failing UI check(s): A ${stamp}`;
  const msgB = `Pre-existing failing UI check(s): B ${stamp}`;

  try {
    expect(logIssueOnce(SOURCE, msgA, "first")).toBe(true);
    expect(logIssueOnce(SOURCE, msgA, "second")).toBe(false);
    expect(openCount(msgA)).toBe(1);

    expect(logIssueOnce(SOURCE, msgB)).toBe(true);
    expect(openCount(msgB)).toBe(1);
    expect(openCount(msgA)).toBe(1);

    const db = openTestDb();
    try {
      db.prepare(
        `UPDATE issues SET status='resolved', resolved_at=datetime('now') WHERE source = ? AND message = ?`
      ).run(SOURCE, msgA);
    } finally {
      db.close();
    }

    expect(logIssueOnce(SOURCE, msgA)).toBe(true);
    expect(openCount(msgA)).toBe(1);
  } finally {
    cleanup();
  }
});
