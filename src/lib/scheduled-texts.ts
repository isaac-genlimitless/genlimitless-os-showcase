import db, { getState, logIssue, setState } from "./db";
import { centralOffset, fmtCentral, parseStored, toSqliteUtc } from "./time";
import { createApprovalRequest } from "./agents/registry";
import { isOwnerCell } from "./instance";

// Texts agents queue for Owner at a future time. THE RECIPIENT IS ALWAYS OWNER: there is deliberately no
// recipient column or argument anywhere; the only sender (defaultSend) uses OWNER_IMESSAGE_HANDLE.
export const MAX_TEXT_CHARS = 300;
const MAX_PENDING = 25, MAX_HORIZON_DAYS = 366, PAST_GRACE_MS = 60_000;
const MAX_ATTEMPTS = 3, RETRY_BACKOFF_MIN = 2, LATE_NOTE_AFTER_MIN = 30, STUCK_SENDING_MIN = 5;

db.exec(`
CREATE TABLE IF NOT EXISTS scheduled_texts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  send_at TEXT NOT NULL,                   -- UTC 'YYYY-MM-DD HH:MM:SS' (same format as datetime('now'))
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | sending | sent | failed | cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_attempt_at INTEGER,                 -- unix ms
  send_id INTEGER REFERENCES imessage_sends(id),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_texts_due ON scheduled_texts(status, send_at);
`);

type Row = { id: number; message: string; send_at: string; reason: string; requested_by: string; status: string; attempts: number; next_attempt_at: string | null; last_attempt_at: number | null; send_id: number | null; error: string | null };

const offsetMs = (d: Date) => {
  const m = /^([+-])(\d\d):(\d\d)$/.exec(centralOffset(d));
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
};

/** ISO with an offset/Z is taken as written; "YYYY-MM-DD[T ]HH:MM[:SS]" with no offset is Central Time (DST-safe). */
export function parseSendAt(input: string): Date | null {
  const s = input.trim();
  if (/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?([zZ]|[+-]\d\d:?\d\d)$/.test(s)) {
    const d = new Date(s.replace(" ", "T"));
    return isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0)];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, sec);
  const chk = new Date(asUtc);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d || h > 23 || mi > 59 || sec > 59) return null;
  let inst = asUtc - offsetMs(new Date(asUtc));
  inst = asUtc - offsetMs(new Date(inst));
  return new Date(inst);
}

const when = (utc: string) => fmtCentral(utc, { year: "numeric" });

export function scheduleText(input: { message: string; send_at: string; reason: string; requested_by: string }) {
  const message = (input.message || "").trim();
  const reason = (input.reason || "").trim();
  if (!message) throw new Error("message is required");
  if (message.length > MAX_TEXT_CHARS) throw new Error(`message is ${message.length} chars; keep it under ${MAX_TEXT_CHARS}`);
  if (!reason) throw new Error("reason is required");
  const at = parseSendAt(input.send_at || "");
  if (!at) throw new Error('send_at must be like "2026-10-07T07:30:00-05:00" or "2026-10-07 07:30" (Central Time)');
  if (at.getTime() < Date.now() - PAST_GRACE_MS) throw new Error(`send_at ${fmtCentral(at, { year: "numeric" })} is in the past`);
  if (at.getTime() > Date.now() + MAX_HORIZON_DAYS * 86_400_000) throw new Error(`send_at is more than ${MAX_HORIZON_DAYS} days away`);
  const sendAt = toSqliteUtc(at);
  const dup = db.prepare(`SELECT id FROM scheduled_texts WHERE status='pending' AND message=? AND send_at=?`).get(message, sendAt) as { id: number } | undefined;
  if (dup) return { scheduled_text_id: dup.id, duplicate: true, sends_at: when(sendAt) };
  const n = (db.prepare(`SELECT COUNT(*) n FROM scheduled_texts WHERE status IN ('pending','sending') AND requested_by <> 'test'`).get() as { n: number }).n;
  if (n >= MAX_PENDING) throw new Error(`${MAX_PENDING} scheduled texts are already pending; ask Owner before queueing more`);
  const id = Number(db.prepare(`INSERT INTO scheduled_texts (message, send_at, reason, requested_by) VALUES (?,?,?,?)`).run(message, sendAt, reason, input.requested_by || "unknown").lastInsertRowid);
  return { scheduled_text_id: id, status: "pending", sends_at: when(sendAt), to: "Owner" };
}

export function listScheduledTexts(status: "pending" | "all" = "pending") {
  const rows = db.prepare(
    `SELECT t.id, t.message, t.send_at, t.reason, t.requested_by, t.status, t.attempts, t.error, t.sent_at, t.cancel_reason,
            s.status AS delivery_status,
            EXISTS (SELECT 1 FROM approval_requests a WHERE a.status='pending' AND a.action='cancel_scheduled_text' AND a.target_id=t.id) AS cancel_awaiting_owner
     FROM scheduled_texts t LEFT JOIN imessage_sends s ON s.id = t.send_id AND substr(s.text,1,length(t.message)) = t.message AND s.purpose='alert'
     WHERE t.requested_by <> 'test' ${status === "pending" ? "AND t.status IN ('pending','sending')" : ""}
     ORDER BY t.send_at ASC LIMIT 50`
  ).all() as any[];
  return rows.map((r) => ({ ...r, sends_at: when(r.send_at), cancel_awaiting_owner: !!r.cancel_awaiting_owner }));
}

/** Never cancels directly: files an approval request. The row is only marked cancelled (kept, never deleted) when Owner approves. */
export function requestCancelScheduledText(input: { id: number; reason: string; requested_by: string }) {
  const row = db.prepare(`SELECT * FROM scheduled_texts WHERE id=?`).get(input.id) as Row | undefined;
  if (!row) throw new Error(`No scheduled text #${input.id}`);
  if (row.status !== "pending") throw new Error(`Scheduled text #${input.id} is already ${row.status}; it can't be cancelled`);
  return createApprovalRequest({
    requested_by: input.requested_by,
    action: "cancel_scheduled_text",
    target_id: row.id,
    title: `Cancel scheduled text #${row.id} (${when(row.send_at)}): "${row.message.slice(0, 80)}"`,
    reason: input.reason,
    payload: { id: row.id, reason: input.reason },
  });
}

/** Runs only from decideApproval when Owner approves. Soft: status flips to 'cancelled', the row stays for history. */
export function applyScheduledTextCancel(id: number, reason: string) {
  const r = db.prepare(`UPDATE scheduled_texts SET status='cancelled', cancelled_at=datetime('now'), cancel_reason=? WHERE id=? AND status='pending'`).run(reason || "approved by Owner", id);
  if (r.changes !== 1) {
    const row = db.prepare(`SELECT status FROM scheduled_texts WHERE id=?`).get(id) as { status: string } | undefined;
    throw new Error(row ? `Scheduled text #${id} is already ${row.status}; nothing to cancel` : `No scheduled text #${id}`);
  }
  return { cancelled: id };
}

// ---------- sending ----------

export type SendDeps = { send: (text: string) => Promise<number>; alert?: (text: string) => Promise<void>; now?: () => Date; /** only consider these row ids; used by tests */ ids?: number[] };

const idFilter = (deps: SendDeps) => (deps.ids ? ` AND id IN (${deps.ids.map(Number).filter(Number.isInteger).join(",") || "NULL"})` : "");

async function defaultSend(text: string): Promise<number> {
  if (process.env.TEST_WORKER_INDEX !== undefined || process.env.E2E_START_SERVER) throw new Error("defaultSend refuses to text from a test process");
  const handle = process.env.OWNER_IMESSAGE_HANDLE || "";
  if (!handle) throw new Error("OWNER_IMESSAGE_HANDLE is not set in .env.local");
  const { trackedIMessage } = await import("./delivery");
  // purpose 'alert': delivery verification + email fallback if the text never lands.
  return trackedIMessage({ to: handle, text, purpose: "alert" });
}

async function defaultAlert(text: string) {
  const { notifyOwner } = await import("./delivery");
  const r = await notifyOwner({ message: text, reason: "scheduled text failed", bypassThrottle: true });
  if (r.status === "sent") return;
  const { defaultAccountEmail, sendEmail } = await import("./mail-accounts");
  const account = defaultAccountEmail();
  if (!account) throw new Error("No mail account connected");
  await sendEmail({ account, to: process.env.GMAIL_USER || account, subject: "GenLimitless alert (scheduled text failed)", text });
}

async function failTerminal(row: Row, error: string, deps: SendDeps, sendId: number | null, alreadyAlerted: boolean) {
  db.prepare(`UPDATE scheduled_texts SET status='failed', error=?, send_id=COALESCE(?, send_id) WHERE id=?`).run(error.slice(0, 500), sendId, row.id);
  logIssue("scheduled_texts", `Scheduled text #${row.id} did not go out`, { error, message: row.message, due: when(row.send_at) });
  if (alreadyAlerted) return; // delivery.ts markFailed already texted/emailed Owner for this send
  try {
    await (deps.alert || defaultAlert)(`Scheduled text #${row.id} due ${when(row.send_at)} did not go out: "${row.message.slice(0, 100)}". ${error.slice(0, 80)}`);
  } catch (err: any) {
    logIssue("scheduled_texts:alert", `Couldn't alert Owner that scheduled text #${row.id} failed`, err.message);
  }
}

/** A 'sending' row older than a few minutes means the server died mid-send. trackedIMessage records its imessage_sends row BEFORE sending, so: row found = already handed off (mark sent, never resend); not found = never sent (safe to retry). */
function recoverInterrupted(deps: SendDeps) {
  const cutoff = Date.now() - STUCK_SENDING_MIN * 60_000;
  const stuck = db.prepare(`SELECT * FROM scheduled_texts WHERE status='sending' AND last_attempt_at < ?${idFilter(deps)}`).all(cutoff) as Row[];
  for (const row of stuck) {
    const since = toSqliteUtc(new Date((row.last_attempt_at || 0) - 60_000));
    const sent = db.prepare(`SELECT id FROM imessage_sends WHERE substr(text,1,?)=? AND created_at >= ? ORDER BY id DESC LIMIT 1`).get(row.message.length, row.message, since) as { id: number } | undefined;
    if (sent) db.prepare(`UPDATE scheduled_texts SET status='sent', sent_at=datetime('now'), send_id=? WHERE id=? AND status='sending'`).run(sent.id, row.id);
    else if (row.attempts < MAX_ATTEMPTS) db.prepare(`UPDATE scheduled_texts SET status='pending', error='interrupted before sending; retrying' WHERE id=? AND status='sending'`).run(row.id);
    else void failTerminal(row, "interrupted before sending, out of attempts", deps, null, false);
  }
}

async function sendOne(id: number, deps: SendDeps) {
  const now = (deps.now || (() => new Date()))();
  // Atomic claim: only one caller can move pending -> sending, so a text can never go out twice.
  const claim = db.prepare(`UPDATE scheduled_texts SET status='sending', attempts=attempts+1, last_attempt_at=? WHERE id=? AND status='pending'`).run(now.getTime(), id);
  if (claim.changes !== 1) return false;
  const row = db.prepare(`SELECT * FROM scheduled_texts WHERE id=?`).get(id) as Row;
  const lateMin = (now.getTime() - (parseStored(row.send_at)?.getTime() ?? now.getTime())) / 60_000;
  const text = lateMin > LATE_NOTE_AFTER_MIN ? `${row.message} (scheduled for ${when(row.send_at)})` : row.message; // catch-up after downtime says it's late
  try {
    const sendId = await deps.send(text);
    db.prepare(`UPDATE scheduled_texts SET status='sent', sent_at=datetime('now'), send_id=?, error=NULL WHERE id=?`).run(sendId, id);
    return true;
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (typeof err?.sendId === "number") {
      // Handed to delivery.ts and it already failed + alerted (markFailed). No resend (could duplicate).
      await failTerminal(row, msg, deps, err.sendId, true);
    } else if (row.attempts < MAX_ATTEMPTS) {
      const next = toSqliteUtc(new Date(now.getTime() + RETRY_BACKOFF_MIN * row.attempts * 60_000));
      db.prepare(`UPDATE scheduled_texts SET status='pending', error=?, next_attempt_at=? WHERE id=?`).run(msg.slice(0, 500), next, id);
    } else {
      await failTerminal(row, `${msg} (after ${row.attempts} attempts)`, deps, null, false);
    }
    return false;
  }
}

let running = false;
/** Sends every pending text whose time has arrived. Anything missed while the server was down is "due" and goes out on the first tick after it wakes. */
export async function sendDueScheduledTexts(deps: SendDeps = { send: defaultSend }) {
  if (running) return;
  running = true;
  try {
    recoverInterrupted(deps);
    const nowUtc = toSqliteUtc((deps.now || (() => new Date()))());
    const due = db.prepare(`SELECT id FROM scheduled_texts WHERE status='pending' AND send_at <= ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)${idFilter(deps)} ORDER BY send_at LIMIT 20`).all(nowUtc, nowUtc) as { id: number }[];
    for (const { id } of due) await sendOne(id, deps);
  } finally {
    running = false;
  }
}

// ---------- first use case (seeded exactly once, on the first tick after the feature is live) ----------
const SEED_KEY = "migration:scheduled-text-talk-oct11-v1";
export function seedScheduledTextsOnce() {
  if (!isOwnerCell()) return; // Owner's own reminder: never seeded into a member's database
  if (getState(SEED_KEY)) return;
  db.transaction(() => {
    const message = "Write your talk for Sunday (Oct 11) now.";
    const sendAt = "2026-10-07 12:30:00"; // Wed Oct 7, 2026 7:30am CDT (UTC-5)
    const have = db.prepare(`SELECT id FROM scheduled_texts WHERE message=? AND send_at=?`).get(message, sendAt) as { id: number } | undefined;
    const id = have?.id ?? Number(db.prepare(`INSERT INTO scheduled_texts (message, send_at, reason, requested_by) VALUES (?,?,?,?)`).run(message, sendAt, "Owner asked (via the Chief of Staff) for a reminder to write his Oct 11 talk", "chief_of_staff").lastInsertRowid);
    setState(SEED_KEY, `scheduled_text #${id}`);
  })();
}

/** Called every minute and once at startup by scheduler.ts (dynamic import, so a fix on disk loads on the next tick). */
export async function runScheduledTextsTick(deps?: SendDeps) {
  if (!deps && process.env.E2E_START_SERVER) return; // the isolated e2e server must never send for real
  if (!deps) seedScheduledTextsOnce();
  await sendDueScheduledTexts(deps);
}
