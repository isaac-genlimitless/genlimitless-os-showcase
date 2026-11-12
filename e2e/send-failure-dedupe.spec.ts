import { test, expect } from "./isolated-test";
import { logIssueOnce } from "../src/lib/issue-once";
import { openTestDb } from "./db-handle";

// Guards the send-failure path without ever sending
// anything or running an agent: repeated failures of the same message must not pile up open
// issues, and nodemailer's "Connection timeout" (code ETIMEDOUT) must count as a network error
// (5 minute retry, not 30).

const SOURCE = "send_approved_and_due";
const MESSAGE = "Failed to send message 999999991";

function cleanup() {
  const db = openTestDb();
  try {
    db.prepare(`DELETE FROM issues WHERE source = ? AND message = ?`).run(SOURCE, MESSAGE);
  } finally {
    db.close();
  }
}

test("repeat send failures of the same message keep one open issue", async () => {
  cleanup();
  try {
    expect(logIssueOnce(SOURCE, MESSAGE, "Connection timeout")).toBe(true);
    expect(logIssueOnce(SOURCE, MESSAGE, "Connection timeout")).toBe(false);
    const db = openTestDb();
    try {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM issues WHERE source = ? AND message = ? AND status = 'open'`)
        .get(SOURCE, MESSAGE) as { n: number };
      expect(row.n).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});
