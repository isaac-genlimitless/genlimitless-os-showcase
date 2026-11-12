import { test, expect } from "./isolated-test";
import { openTestDb } from "./db-handle";
import { classifySendError } from "../src/lib/mail-accounts";
import { backoffMinutes, backoffWithJitter, MAX_SEND_ATTEMPTS } from "../src/lib/send-resilience";
import { recordHealth, checkDownAlerts, downIssueMessage, ISSUE_SOURCE } from "../src/lib/mail-health";

// Pure-function and DB tests for self-healing sends. Never presses Send, never triggers the agent.

const ACCOUNT = "e2e-health-test@example.invalid";

function cleanup() {
  const db = openTestDb();
  try {
    db.prepare(`DELETE FROM mail_health WHERE account = ?`).run(ACCOUNT);
    db.prepare(`DELETE FROM issues WHERE source = ? AND message = ?`).run(ISSUE_SOURCE, downIssueMessage(ACCOUNT));
  } finally {
    db.close();
  }
}

test("classifySendError table", () => {
  expect(classifySendError(Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT", command: "CONN" }))).toBe("safe_retry");
  expect(classifySendError(Object.assign(new Error("x"), { code: "ECONNRESET", command: "EHLO" }))).toBe("safe_retry");
  expect(classifySendError(Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }))).toBe("safe_retry");
  expect(classifySendError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT", command: "DATA" }))).toBe("uncertain");
  expect(classifySendError(Object.assign(new Error("closed"), { code: "ECONNECTION", command: "." }))).toBe("uncertain");
  expect(classifySendError(Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 }))).toBe("permanent");
  expect(classifySendError(Object.assign(new Error("550"), { responseCode: 550, command: "RCPT TO" }))).toBe("permanent");
});

test("backoff is 5,10,20,40,60,60... minutes, jitter stays within 20%, cap is 12 attempts", () => {
  expect([1, 2, 3, 4, 5, 6, 12].map(backoffMinutes)).toEqual([5, 10, 20, 40, 60, 60, 60]);
  expect(backoffWithJitter(3, 0)).toBeCloseTo(16);
  expect(backoffWithJitter(3, 1)).toBeCloseTo(24);
  expect(MAX_SEND_ATTEMPTS).toBe(12);
});

test("5 failing sends on one account make one open issue; a good probe resolves it", () => {
  cleanup();
  try {
    for (let i = 0; i < 5; i++) recordHealth(ACCOUNT, false, "Connection timeout");
    const db = openTestDb();
    try {
      const open = () =>
        (db.prepare(`SELECT COUNT(*) AS n FROM issues WHERE source=? AND message=? AND status='open'`).get(ISSUE_SOURCE, downIssueMessage(ACCOUNT)) as { n: number }).n;
      expect(open()).toBe(1);
      recordHealth(ACCOUNT, true);
      expect(open()).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test("down over an hour alerts exactly once, with bypassThrottle", async () => {
  cleanup();
  try {
    const t0 = Date.now() - 90 * 60_000;
    recordHealth(ACCOUNT, false, "Connection timeout", t0);
    recordHealth(ACCOUNT, false, "Connection timeout", t0 + 60_000);
    const calls: any[] = [];
    const notify = (async (i: any) => (calls.push(i), { status: "sent" })) as any;
    // Other real rows may be down on this machine; count only this account's alerts.
    await checkDownAlerts(notify);
    await checkDownAlerts(notify);
    const mine = calls.filter((c) => c.message.includes(ACCOUNT));
    expect(mine).toHaveLength(1);
    expect(mine[0].bypassThrottle).toBe(true);
  } finally {
    cleanup();
  }
});
