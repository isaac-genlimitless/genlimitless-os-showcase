import { ImapFlow, FetchMessageObject } from "imapflow";
import db, { logIssue } from "./db";
import { legacyImapCreds, listAccounts } from "./mail-accounts";

// Primary real-time path (per the issue's corrected instructions): a persistent IMAP IDLE
// connection per app-password account, authenticated exactly like mail.ts, that reacts the
// instant new mail lands - no polling. OAuth accounts aren't watched here (no Gmail OAuth
// account exists yet and the issue says to drop XOAUTH2); this stays isolated so an OAuth
// watch path could be added alongside it later without touching this file's logic.
//
// The Mac sleeps and Wi-Fi drops, so every reconnect - including the very first connect -
// does a catch-up fetch of anything newer than the last UID we've persisted for that account,
// then reconnects with exponential backoff on any error.

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 2 * 60_000;
const HEALTHY_RESET_MS = 60_000; // a session healthy this long resets the backoff
const DROP_LOG_INTERVAL_MS = 6 * 60 * 60_000;
// Real health probe (NOOP) cadence. Kept under the 120s socketTimeout so the probe's own
// traffic never trips the socket-inactivity timeout.
const PROBE_INTERVAL_MS = 90_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLastUid(account: string): number {
  const row = db.prepare(`SELECT last_uid FROM imap_watch_state WHERE account = ?`).get(account) as
    | { last_uid: number }
    | undefined;
  return row?.last_uid ?? 0;
}

/** Decides where a watch should start reading from. If we've watched this account before (a
 *  row already exists), resume from its last recorded UID so mail that arrived during a
 *  disconnect/sleep gap gets caught up. Otherwise - the very first time an account is watched -
 *  baseline to the mailbox's current highest UID so years of pre-existing mail never gets
 *  treated as newly arrived. */
export function resolveStartUid(account: string, mailboxUidNext: number): number {
  const row = db.prepare(`SELECT last_uid FROM imap_watch_state WHERE account = ?`).get(account) as
    | { last_uid: number }
    | undefined;
  if (row) return row.last_uid;
  return Math.max(0, mailboxUidNext - 1);
}

/** Reconnect backoff for the next attempt: a session that stayed healthy long enough resets to
 *  the base delay; otherwise it doubles up to the cap. Pure so it can be unit tested. */
export function nextBackoff(prev: number, healthyMs: number): number {
  if (healthyMs > HEALTHY_RESET_MS) return BASE_BACKOFF_MS;
  return Math.min(prev * 2, MAX_BACKOFF_MS);
}

/** ±20% jitter so both accounts don't reconnect in lockstep. `rand` is injectable for tests. */
export function withJitter(ms: number, rand: () => number = Math.random): number {
  return Math.round(ms * (0.8 + rand() * 0.4));
}

/** Only log a drop as an issue on the first drop of an outage, then again every 6h if still
 *  down, so repeated identical drops don't flood the open-issues list. `downSinceMs` is when the
 *  outage began before this drop (null = this is the first drop). */
export function shouldLogDrop(downSinceMs: number | null, lastLoggedMs: number | undefined, nowMs: number): boolean {
  if (downSinceMs === null) return true;
  return nowMs - (lastLoggedMs ?? downSinceMs) >= DROP_LOG_INTERVAL_MS;
}

function setWatchState(account: string, lastUid: number, status: "watching" | "error", error?: string) {
  db.prepare(
    `INSERT INTO imap_watch_state (account, last_uid, status, last_seen_at, last_error, updated_at, last_ok_at, down_since, consecutive_failures)
     VALUES (?, ?, ?, datetime('now'), ?, datetime('now'),
             CASE WHEN ? = 'watching' THEN datetime('now') ELSE NULL END,
             CASE WHEN ? = 'error' THEN datetime('now') ELSE NULL END,
             CASE WHEN ? = 'error' THEN 1 ELSE 0 END)
     ON CONFLICT(account) DO UPDATE SET
       last_uid = excluded.last_uid,
       status = excluded.status,
       last_seen_at = CASE WHEN excluded.status = 'watching' THEN datetime('now') ELSE imap_watch_state.last_seen_at END,
       last_ok_at = CASE WHEN excluded.status = 'watching' THEN datetime('now') ELSE imap_watch_state.last_ok_at END,
       last_error = excluded.last_error,
       down_since = CASE WHEN excluded.status = 'watching' THEN NULL ELSE COALESCE(imap_watch_state.down_since, datetime('now')) END,
       consecutive_failures = CASE WHEN excluded.status = 'watching' THEN 0 ELSE COALESCE(imap_watch_state.consecutive_failures, 0) + 1 END,
       updated_at = datetime('now')`
  ).run(account, lastUid, status, error || null, status, status, status);
}

function getDownSinceMs(account: string): number | null {
  const row = db.prepare(`SELECT down_since FROM imap_watch_state WHERE account = ?`).get(account) as
    | { down_since: string | null }
    | undefined;
  if (!row?.down_since) return null;
  return new Date(row.down_since.replace(" ", "T") + "Z").getTime();
}

/** Reads the UIDs of mail newer than sinceUid and tells Chief's inbound sweep about it. The watcher
 *  stores nothing itself: the sweep reads the mail, decides what it implies (task, calendar item,
 *  reminder text, reply draft, nothing) and does it. `onNew` is injectable so tests never wake the
 *  agent. Returns the highest UID seen, which the caller persists. */
export async function processNewMessages(
  client: ImapFlow,
  account: string,
  sinceUid: number,
  onNew: (account: string, count: number) => void = () => void import("./inbound-sweep").then((m) => m.requestSweepSoon("new mail")),
): Promise<number> {
  let maxUid = sinceUid;
  if (!client.mailbox) return maxUid;
  const total = typeof client.mailbox === "object" ? client.mailbox.exists : 0;
  if (!total) return maxUid;

  let fresh = 0;
  const range = `${sinceUid + 1}:*`;
  for await (const msg of client.fetch(range, { uid: true }, { uid: true }) as AsyncIterable<FetchMessageObject>) {
    if (!msg.uid || msg.uid <= sinceUid) continue;
    maxUid = Math.max(maxUid, msg.uid);
    fresh++;
  }
  if (fresh > 0) {
    try {
      onNew(account, fresh);
    } catch (err: any) {
      logIssue("imap_idle", `Could not hand new mail on ${account} to the inbound sweep`, err.message);
    }
  }
  return maxUid;
}

async function watchAccountOnce(email: string, onHealthy: () => void) {
  const creds = legacyImapCreds(email);
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    // A half-open socket after the Mac sleeps must fail fast instead of hanging forever.
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  });

  // Without an 'error' listener an emitted error is thrown at process level. Record it and let
  // the 'close' promise end the idle loop so the outer loop reconnects.
  let clientError: Error | null = null;
  let closed = false;
  const closedPromise = new Promise<void>((resolve) => {
    client.on("close", () => {
      closed = true;
      resolve();
    });
  });
  client.on("error", (err: Error) => {
    clientError = err;
  });
  const failure = () => clientError || new Error("Connection closed");

  await client.connect();
  let probeTimer: ReturnType<typeof setInterval> | undefined;
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      onHealthy();
      // Startup/reconnect catch-up covers whatever landed while we were asleep or disconnected;
      // the very first watch of an account instead baselines to its current highest UID so
      // pre-existing mailbox history is never processed as new mail (see resolveStartUid).
      const mailboxUidNext = typeof client.mailbox === "object" ? client.mailbox.uidNext : 1;
      let lastUid = await processNewMessages(client, email, resolveStartUid(email, mailboxUidNext));
      setWatchState(email, lastUid, "watching");

      // Real health probe: running a command interrupts idle(), so NOOP doubles as the idle
      // breaker. A successful NOOP is what marks the watch "watching" (last_seen_at/last_ok_at);
      // a failed one destroys the socket so the outer loop reconnects immediately.
      let probing = false;
      probeTimer = setInterval(async () => {
        if (probing || closed) return;
        probing = true;
        try {
          await client.noop();
          setWatchState(email, lastUid, "watching");
        } catch (err: any) {
          clientError = clientError || err;
          client.close();
        } finally {
          probing = false;
        }
      }, PROBE_INTERVAL_MS);

      // imapflow's idle() resolves whenever the mailbox changes (or the probe interrupts it),
      // so this loop reacts the instant new mail arrives without polling for mail on our own timer.
      while (true) {
        if (closed) throw failure();
        await Promise.race([client.idle(), closedPromise]);
        if (closed) throw failure();
        lastUid = await processNewMessages(client, email, lastUid);
      }
    } finally {
      try {
        lock.release();
      } catch {
        // socket already gone; nothing to release
      }
    }
  } finally {
    if (probeTimer) clearInterval(probeTimer);
    if (closed) {
      // already closed; logout would just throw "Connection not available"
    } else {
      await client.logout().catch(() => client.close());
    }
  }
}

async function watchAccountForever(email: string) {
  let backoff = BASE_BACKOFF_MS;
  let lastLoggedMs: number | undefined;
  while (true) {
    const session = { healthySince: null as number | null };
    let clean = false;
    try {
      await watchAccountOnce(email, () => {
        session.healthySince = Date.now();
      });
      clean = true;
    } catch (err: any) {
      const now = Date.now();
      const downSinceMs = getDownSinceMs(email); // before this drop is recorded
      setWatchState(email, getLastUid(email), "error", err.message);
      if (shouldLogDrop(downSinceMs, lastLoggedMs, now)) {
        lastLoggedMs = now;
        logIssue("imap_idle", `IMAP watch for ${email} dropped, reconnecting`, err.message);
      }
    }
    const healthyMs = session.healthySince ? Date.now() - session.healthySince : 0;
    // A session that stayed healthy >60s resets to the base delay before this wait; otherwise
    // wait the current backoff (5s, 10s, 20s ... cap 2 min) and double it for next time.
    const wait = healthyMs > HEALTHY_RESET_MS ? BASE_BACKOFF_MS : backoff;
    backoff = nextBackoff(wait, healthyMs);
    // A clean session end isn't a failure, so only pause briefly; failures wait the backoff.
    await sleep(clean ? 1_000 : withJitter(wait));
  }
}

let started = false;

/** Called once at server startup (instrumentation.ts), never in test servers. */
export function startImapIdleWatchers() {
  if (started) return;
  started = true;

  const accounts = listAccounts().filter((a) => a.kind === "legacy_app_password");
  if (accounts.length === 0) {
    logIssue("imap_idle", "No app-password mail accounts to watch - set GMAIL_USER/GMAIL_APP_PASSWORD");
    return;
  }
  for (const account of accounts) void watchAccountForever(account.email);
  console.log(`[imap-idle] watching ${accounts.map((a) => a.email).join(", ")}`);
}
