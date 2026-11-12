import db, { logIssue } from "./db";
import { notifyOwner } from "./delivery";
import { listAccounts, probeAccount } from "./mail-accounts";
import { resolveIssuesBySource, upsertOpenIssue } from "./issue-once";
import { MAX_SEND_ATTEMPTS } from "./send-resilience";

// Per-account send-path health. A probe (SMTP verify + IMAP NOOP, nothing is sent) runs every 5 min,
// and real send attempts feed the same record. One outage = one open, self-resolving issue and one
// "down over an hour" alert to Owner.

export const ISSUE_SOURCE = "mail_health";
const DOWN_AFTER_FAILURES = 2;
const ALERT_AFTER_MIN = 60;
const ALERT_REPEAT_MIN = 6 * 60;

export const downIssueMessage = (account: string) => `Sending is down for ${account}`;
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const parseSql = (s: string) => new Date(s.replace(" ", "T") + "Z").getTime();

export type MailHealthRow = {
  account: string;
  status: string | null;
  consecutive_failures: number;
  last_ok_at: string | null;
  last_error: string | null;
  last_checked_at: string | null;
  down_since: string | null;
  alerted_at: string | null;
};

export function errorKind(error: string | null | undefined): "auth" | "timeout" {
  return /EAUTH|535|AUTHENTICATIONFAILED|Invalid credentials|Username and Password not accepted/i.test(error || "") ? "auth" : "timeout";
}

export function countApprovedWaiting(): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE status='approved'`).get() as { c: number }).c;
}

function issueDetail(row: MailHealthRow) {
  const needsHuman = db
    .prepare(`SELECT id, last_send_error, send_attempts FROM messages WHERE status='approved' AND (send_attempts >= ? OR last_send_error LIKE 'permanent:%')`)
    .all(MAX_SEND_ATTEMPTS) as { id: number; last_send_error: string | null; send_attempts: number }[];
  return {
    cause: row.last_error,
    kind: errorKind(row.last_error) === "auth" ? "app password rejected / blocked" : "network timeout",
    down_since: row.down_since,
    approved_unsent: countApprovedWaiting(),
    needs_owner: needsHuman.map((m) => `message ${m.id} (${m.send_attempts} attempts): ${m.last_send_error ?? ""}`),
  };
}

/** Records one probe or send outcome for an account and keeps the single account-level issue in step. */
export function recordHealth(account: string, ok: boolean, error?: string | null, nowMs: number = Date.now()) {
  const now = sqlTime(nowMs);
  db.prepare(`INSERT OR IGNORE INTO mail_health (account, status, consecutive_failures) VALUES (?, 'ok', 0)`).run(account);
  const row = db.prepare(`SELECT * FROM mail_health WHERE account = ?`).get(account) as MailHealthRow;

  if (ok) {
    const wasDown = row.status === "down";
    db.prepare(
      `UPDATE mail_health SET status='ok', consecutive_failures=0, last_ok_at=?, last_error=NULL, last_checked_at=?, down_since=NULL, alerted_at=NULL WHERE account=?`
    ).run(now, now, account);
    if (wasDown || row.consecutive_failures > 0) {
      const note = `sending recovered at ${now} UTC`;
      resolveIssuesBySource(ISSUE_SOURCE, note, downIssueMessage(account));
      resolveIssuesBySource("send_approved_and_due", note, "Failed to send message");
    }
    return;
  }

  const failures = (row.consecutive_failures || 0) + 1;
  const downSince = row.down_since || now; // cleared on the next success
  const status = failures >= DOWN_AFTER_FAILURES ? "down" : "degraded";
  db.prepare(
    `UPDATE mail_health SET status=?, consecutive_failures=?, last_error=?, last_checked_at=?, down_since=? WHERE account=?`
  ).run(status, failures, String(error ?? "unknown error").slice(0, 300), now, downSince, account);
  if (status === "down") {
    const fresh = db.prepare(`SELECT * FROM mail_health WHERE account = ?`).get(account) as MailHealthRow;
    upsertOpenIssue(ISSUE_SOURCE, downIssueMessage(account), issueDetail(fresh));
  }
}

/** Texts Owner ONCE per outage once an account has been down over an hour (again only after 6h).
 *  bypassThrottle so the daily alert cap can't swallow it. notify/nowMs injectable for tests. */
export async function checkDownAlerts(notify: typeof notifyOwner = notifyOwner, nowMs: number = Date.now()) {
  const rows = db.prepare(`SELECT * FROM mail_health WHERE status='down' AND down_since IS NOT NULL`).all() as MailHealthRow[];
  let sent = 0;
  for (const row of rows) {
    if (nowMs - parseSql(row.down_since!) <= ALERT_AFTER_MIN * 60_000) continue;
    if (row.alerted_at && nowMs - parseSql(row.alerted_at) <= ALERT_REPEAT_MIN * 60_000) continue;
    const kind = errorKind(row.last_error) === "auth" ? "the app password was rejected" : "connection timeouts";
    const result = await notify({
      message: `Sending is down for ${row.account} since ${row.down_since} UTC (${kind}). ${countApprovedWaiting()} approved email(s) are waiting. Check the server's network or the app password.`,
      reason: "mail_health: sending down over 1 hour",
      bypassThrottle: true,
    });
    // Mark alerted even if the Mac worker is offline: the in-app issue stays open as the durable signal.
    db.prepare(`UPDATE mail_health SET alerted_at=? WHERE account=?`).run(sqlTime(nowMs), row.account);
    if (result) sent++;
  }
  return sent;
}

export function anyAccountDown(): boolean {
  return !!db.prepare(`SELECT 1 FROM mail_health WHERE status='down' LIMIT 1`).get();
}

export function accountIsDown(account: string): boolean {
  return !!db.prepare(`SELECT 1 FROM mail_health WHERE lower(account)=lower(?) AND status='down' LIMIT 1`).get(account);
}

let probing = false;
/** Every 5 minutes from the scheduler. */
export async function runMailHealthProbe() {
  if (probing) return;
  probing = true;
  try {
    for (const a of listAccounts().filter((x) => x.status === "connected")) {
      try {
        await probeAccount(a.email);
        recordHealth(a.email, true);
      } catch (err: any) {
        recordHealth(a.email, false, err?.message || String(err));
      }
    }
    await checkDownAlerts();
    try {
      await (await import("./bridge-health")).checkBridgeHealth();
    } catch (e: any) {
      logIssue("bridge_health", "check failed", e.message);
    }
  } finally {
    probing = false;
  }
}
