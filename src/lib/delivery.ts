import db, { logIssue } from "./db";
import { APPLE_EPOCH, MIRROR_MODE, decodeAttributedBody, messagesDb, normalizeHandle, sendIMessage } from "./imessage";
import { bridgeAlertHoldActive } from "./bridge-health";
import { sendEmail, defaultAccountEmail } from "./mail-accounts";

// Delivery verification. A send "succeeding" only means Messages / SMTP accepted it —
// these checks confirm it actually arrived, retry once, and escalate if it didn't.

const OWNER_HANDLE = process.env.OWNER_IMESSAGE_HANDLE || "";
const CHECK_AFTER_MS = 60_000; // give Messages a minute before judging
const GIVE_UP_AFTER_MS = 4 * 60_000; // undelivered this long after the last attempt = failed
const MAX_ATTEMPTS = 2;

type SendRow = {
  id: number;
  to_handle: string | null;
  chat_guid: string | null;
  text: string;
  purpose: "alert" | "manual" | "login_code";
  status: string;
  attempts: number;
  last_attempt_at: number;
};

async function attempt(row: Pick<SendRow, "id" | "to_handle" | "chat_guid" | "text">) {
  db.prepare(`UPDATE imessage_sends SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?`).run(
    Date.now(),
    row.id
  );
  await sendIMessage({ to: row.to_handle || undefined, chatGuid: row.chat_guid || undefined, text: row.text });
}

/** Send an iMessage and track it until it's confirmed delivered. Returns the tracking id. */
export async function trackedIMessage(opts: {
  to?: string;
  chatGuid?: string;
  text: string;
  purpose: "alert" | "manual";
}): Promise<number> {
  // On the server the text is only queued; the Mac worker sends it and reports back (bridge/outbox-cli.mjs).
  const id = Number(
    db
      .prepare(`INSERT INTO imessage_sends (to_handle, chat_guid, text, purpose, status) VALUES (?, ?, ?, ?, ?)`)
      .run(opts.to || null, opts.chatGuid || null, opts.text, opts.purpose, MIRROR_MODE ? "queued" : "pending").lastInsertRowid
  );
  if (MIRROR_MODE) return id;
  try {
    await attempt({ id, to_handle: opts.to || null, chat_guid: opts.chatGuid || null, text: opts.text });
  } catch (err: any) {
    // Messages refused outright — no point waiting for the verifier.
    await markFailed(id, `Messages.app refused the send: ${err.message}`);
    throw Object.assign(err, { sendId: id }); // lets scheduled-texts know delivery already handled + alerted this failure
  }
  return id;
}

function appleNs(unixMs: number) {
  return (unixMs / 1000 - APPLE_EPOCH) * 1e9;
}

// Find our outgoing message in chat.db (sent at/after the attempt, same text, same recipient).
export function findInChatDb(row: SendRow) {
  const candidates = messagesDb()
    .prepare(
      `SELECT m.ROWID as rowid, m.text, m.attributedBody, m.is_sent, m.is_delivered, m.error, m.service,
              h.id as handle, c.guid as chat_guid
       FROM message m
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       LEFT JOIN chat c ON c.ROWID = cmj.chat_id
       WHERE m.is_from_me = 1 AND m.date >= ?
       ORDER BY m.date DESC LIMIT 200`
    )
    .all(appleNs(row.last_attempt_at - 5000)) as any[];
  const want = row.text.trim();
  return candidates.find((m) => {
    const text = (m.text ?? decodeAttributedBody(m.attributedBody) ?? "").trim();
    if (text !== want) return false;
    if (row.chat_guid) return m.chat_guid === row.chat_guid;
    return m.handle && normalizeHandle(m.handle) === normalizeHandle(row.to_handle || "");
  });
}

async function markFailed(id: number, error: string) {
  db.prepare(`UPDATE imessage_sends SET status='failed', error=? WHERE id=?`).run(error, id);
  const row = db.prepare(`SELECT * FROM imessage_sends WHERE id=?`).get(id) as SendRow;
  if (row.purpose === "login_code") {
    // Never log, email or re-text the message body: it holds a login code.
    db.prepare(`UPDATE imessage_sends SET text=? WHERE id=?`).run(LOGIN_CODE_REDACTED, id);
    logIssue("delivery:imessage", "login code iMessage not delivered", { error });
    return;
  }
  const who = row.chat_guid ? `group chat` : row.to_handle;
  logIssue("delivery:imessage", `iMessage to ${who} was not delivered`, { error, text: row.text });

  if (row.purpose === "alert") {
    // The alert channel itself is broken — fall back to email so Owner still hears about it.
    try {
      const account = defaultAccountEmail();
      if (!account) throw new Error("No mail account connected");
      await sendEmail({
        account,
        to: process.env.GMAIL_USER || account,
        subject: "GenLimitless alert (iMessage failed)",
        text: `${row.text}\n\n— This alert couldn't be delivered by iMessage (${error}), so it came by email instead.`,
      });
      db.prepare(`UPDATE imessage_sends SET status='fallback_email' WHERE id=?`).run(id);
    } catch (err: any) {
      logIssue("delivery:alert_fallback", "Alert could not be delivered by iMessage OR email", err.message);
    }
  } else {
    // A message Owner sent from the OS didn't land — tell him.
    await notifyOwner({
      message: `Your iMessage to ${who} didn't deliver: "${row.text.slice(0, 80)}". Resend from your phone.`,
      reason: "delivery verification failed on a message Owner sent",
      bypassThrottle: true,
    });
  }
}

/** Runs every minute from the scheduler. */
export async function verifyIMessageDeliveries() {
  if (MIRROR_MODE) return verifyQueuedSends();
  const pending = db
    .prepare(`SELECT * FROM imessage_sends WHERE status='pending' AND purpose != 'login_code' AND last_attempt_at < ?`)
    .all(Date.now() - CHECK_AFTER_MS) as SendRow[];

  for (const row of pending) {
    const found = findInChatDb(row);
    // Group chats never set is_delivered, so is_sent is the best signal there.
    const ok = found && !found.error && (row.chat_guid ? found.is_sent : found.is_delivered);
    if (ok) {
      db.prepare(`UPDATE imessage_sends SET status='delivered', chat_rowid=? WHERE id=?`).run(found.rowid, row.id);
      continue;
    }
    const hardError = found?.error ? `Messages error code ${found.error}` : null;
    if (!hardError && Date.now() - row.last_attempt_at < GIVE_UP_AFTER_MS) continue; // still in flight

    const reason = hardError || (found ? "sent but never marked delivered" : "never appeared in Messages");
    if (row.attempts < MAX_ATTEMPTS) {
      try {
        await attempt(row);
        continue;
      } catch (err: any) {
        await markFailed(row.id, `${reason}; retry refused: ${err.message}`);
        continue;
      }
    }
    await markFailed(row.id, `${reason} after ${row.attempts} attempts`);
  }
}

// Server mode: the Mac worker does the send and the delivery check (against the Mac's own chat.db, since the
// mirror lags by minutes) and reports 'delivered' or 'mac_failed'. Here we only escalate failures and sends the
// Mac never picked up or never finished. No retry on the server: a late Mac could then send twice.
const QUEUE_PICKUP_MIN = 10;
const SENDING_RESULT_MIN = 15;

async function verifyQueuedSends() {
  const rows = db
    .prepare(
      `SELECT id, status, error, purpose FROM imessage_sends
       WHERE status = 'mac_failed'
          OR (status = 'queued' AND created_at < datetime('now', ?))
          OR (status = 'sending' AND last_attempt_at < ?)`
    )
    .all(`-${QUEUE_PICKUP_MIN} minutes`, Date.now() - SENDING_RESULT_MIN * 60_000) as { id: number; status: string; error: string | null; purpose: string }[];
  for (const r of rows) {
    // Alert texts wait for the Mac while the bridge is offline (plus a grace after it returns).
    if (r.status === "queued" && r.purpose === "alert" && bridgeAlertHoldActive()) continue;
    const why =
      r.status === "mac_failed"
        ? r.error || "Messages.app on the Mac refused the send"
        : r.status === "queued"
          ? `the Mac didn't pick it up within ${QUEUE_PICKUP_MIN} min (asleep or offline?)`
          : `the Mac never reported a result within ${SENDING_RESULT_MIN} min`;
    await markFailed(r.id, why);
  }
}

// ---------- Login codes ----------

export const LOGIN_CODE_REDACTED = "[login code redacted]";

/**
 * Text a login code to the signing-in user's own phone (`handle`, from accounts.db users.phone; the caller
 * decides, never a request parameter). Deliberately NOT notifyOwner: no alert throttle, nothing written to alerts.
 * The code is blanked from imessage_sends as soon as the send is handed off (see also bridge/outbox-cli.mjs
 * and redactStaleLoginCodes). Throws a generic error on failure; never include the code in it.
 */
export async function sendLoginCode(code: string, handle: string): Promise<number> {
  if (!handle) throw new Error("login code not sent: recipient not configured");
  const text = `GenLimitless login code: ${code}. Expires in 5 min. Don't share it.`;
  const id = Number(
    db
      .prepare(`INSERT INTO imessage_sends (to_handle, chat_guid, text, purpose, status) VALUES (?, NULL, ?, 'login_code', ?)`)
      .run(handle, text, MIRROR_MODE ? "queued" : "pending").lastInsertRowid
  );
  if (MIRROR_MODE) return id; // the Mac worker redacts on result; the sweep is the backstop
  try {
    await attempt({ id, to_handle: handle, chat_guid: null, text });
    // Handed off to Messages.app. Chat-db matching is skipped for login codes, so mark done and blank the text.
    db.prepare(`UPDATE imessage_sends SET status='delivered', text=? WHERE id=?`).run(LOGIN_CODE_REDACTED, id);
  } catch (err: any) {
    await markFailed(id, `Messages.app refused the send: ${String(err?.message || "").replaceAll(code, "[code]")}`);
    throw new Error("login code not delivered");
  }
  return id;
}

/** Blank any login-code text older than 10 minutes (crashed worker backstop). Runs from the scheduler. */
export function redactStaleLoginCodes() {
  return db
    .prepare(
      `UPDATE imessage_sends SET text=? WHERE purpose='login_code' AND text != ? AND created_at < datetime('now','-10 minutes')`
    )
    .run(LOGIN_CODE_REDACTED, LOGIN_CODE_REDACTED).changes;
}

// ---------- Alerts to Owner ----------

const ALERT_MIN_GAP_MIN = 10;
const ALERT_MAX_PER_DAY = 8;

export async function notifyOwner(input: { message: string; reason: string; bypassThrottle?: boolean }) {
  const recent = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM alerts WHERE status='sent' AND created_at > datetime('now','-1 day')) as day,
         (SELECT COUNT(*) FROM alerts WHERE status='sent' AND created_at > datetime('now', ?)) as gap`
    )
    .get(`-${ALERT_MIN_GAP_MIN} minutes`) as { day: number; gap: number };
  const text = input.message.slice(0, 300);
  let status = "sent";
  let error: string | null = null;
  if (!input.bypassThrottle && recent.day >= ALERT_MAX_PER_DAY) {
    status = "throttled";
    error = `daily limit of ${ALERT_MAX_PER_DAY} reached`;
  } else if (!input.bypassThrottle && recent.gap > 0) {
    status = "throttled";
    error = `already texted in the last ${ALERT_MIN_GAP_MIN} min — fold this into the next alert or wait`;
  } else if (!OWNER_HANDLE) {
    status = "failed";
    error = "OWNER_IMESSAGE_HANDLE is not set in .env.local";
    logIssue("alerts", "Can't alert Owner: OWNER_IMESSAGE_HANDLE is not set in .env.local");
  } else {
    try {
      // trackedIMessage verifies delivery and falls back to email on failure.
      await trackedIMessage({ to: OWNER_HANDLE, text: `GenLimitless: ${text}`, purpose: "alert" });
    } catch (e: any) {
      status = "failed";
      error = e.message;
    }
  }
  db.prepare(`INSERT INTO alerts (message, reason, status, error) VALUES (?, ?, ?, ?)`).run(
    text,
    input.reason,
    status,
    error
  );
  return { status, error };
}
