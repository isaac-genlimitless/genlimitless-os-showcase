import db from "./db";
import { notifyOwner } from "./delivery";
import { listAccounts } from "./mail-accounts";

// Backstop only - the real-time IMAP IDLE watcher (imap-idle.ts) is the primary path. This
// runs hourly from the scheduler and texts Owner if the watch itself got stuck, so a silent
// failure there doesn't leave inbound mail unseen.

const WATCH_STALE_MIN = 20;

async function checkStaleWatch() {
  const accounts = listAccounts().filter((a) => a.kind === "legacy_app_password");
  if (accounts.length === 0) return;

  const rows = db.prepare(`SELECT account, status, last_seen_at, down_alerted_at FROM imap_watch_state`).all() as {
    account: string;
    status: string;
    last_seen_at: string | null;
    down_alerted_at: string | null;
  }[];
  const byAccount = new Map(rows.map((r) => [r.account.toLowerCase(), r]));

  const stale: string[] = [];
  for (const account of accounts) {
    const row = byAccount.get(account.email.toLowerCase());
    // Already texted about this outage by checkImapDownAlert - don't text again.
    if (row?.down_alerted_at) continue;
    if (!row || row.status === "error" || !row.last_seen_at) {
      stale.push(account.email);
      continue;
    }
    const lastSeen = new Date(row.last_seen_at.replace(" ", "T") + "Z").getTime();
    const ageMin = (Date.now() - lastSeen) / 60_000;
    if (ageMin > WATCH_STALE_MIN) stale.push(account.email);
  }

  if (stale.length > 0) {
    await notifyOwner({
      message: `Email watch looks down for ${stale.join(", ")} - inbound mail may be delayed.`,
      reason: "watchdog: IMAP watch stale or never started",
    });
  }
}

const IMAP_DOWN_ALERT_MIN = 15;

/** Pure decision for one imap_watch_state row: text once when an outage passes 15 min, and once
 *  more ("back up") only if that alert had been sent. nowMs is injectable for tests. */
export function decideImapAlert(
  row: { status: string; down_since: string | null; down_alerted_at: string | null },
  nowMs: number = Date.now()
): "alert" | "recovered" | null {
  if (row.status === "watching") return row.down_alerted_at ? "recovered" : null;
  if (row.status !== "error" || !row.down_since || row.down_alerted_at) return null;
  const downSinceMs = new Date(row.down_since.replace(" ", "T") + "Z").getTime();
  return nowMs - downSinceMs >= IMAP_DOWN_ALERT_MIN * 60_000 ? "alert" : null;
}

/** Runs every minute from the scheduler. Cheap DB read only - never touches IMAP. At most one
 *  alert per outage; notifyOwner's own throttles still apply (if throttled we retry next minute). */
export async function checkImapDownAlert() {
  const accounts = new Set(
    listAccounts()
      .filter((a) => a.kind === "legacy_app_password")
      .map((a) => a.email.toLowerCase())
  );
  if (accounts.size === 0) return;

  const rows = db
    .prepare(`SELECT account, status, down_since, down_alerted_at, last_error FROM imap_watch_state`)
    .all() as {
    account: string;
    status: string;
    down_since: string | null;
    down_alerted_at: string | null;
    last_error: string | null;
  }[];

  for (const row of rows) {
    if (!accounts.has(row.account.toLowerCase())) continue;
    const decision = decideImapAlert(row);
    if (decision === "alert") {
      const authFailed = /AUTHENTICATIONFAILED|Invalid credentials/i.test(row.last_error || "");
      const result = await notifyOwner({
        message: `Business mailbox ${row.account} has been down 15+ min (${
          authFailed ? "app password rejected" : row.last_error || "network"
        }). I'm still retrying.`,
        reason: "watchdog: imap down 15min",
      });
      if (result.status === "sent") {
        db.prepare(`UPDATE imap_watch_state SET down_alerted_at = datetime('now') WHERE account = ?`).run(row.account);
      }
    } else if (decision === "recovered") {
      await notifyOwner({
        message: `Business mailbox ${row.account} is back up and watching again.`,
        reason: "watchdog: imap recovered",
      });
      // Clear the marker whether or not the text got through (throttled): the outage is over.
      db.prepare(`UPDATE imap_watch_state SET down_alerted_at = NULL WHERE account = ?`).run(row.account);
    }
  }
}

/** Runs hourly from the scheduler. */
export async function runEmailWatchdog() {
  await checkStaleWatch();
}
