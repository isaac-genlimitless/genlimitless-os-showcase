import crypto from "crypto";
import db from "../accounts/db";
import { getUser } from "../accounts/users";
import { loginRecipient } from "./recipient";
import { authSecret } from "./crypto";
import { sendLoginCode } from "../delivery";
import { sendEmail, defaultAccountEmail } from "../mail-accounts";

// 6-digit login code (second factor), sent to the signing-in user's OWN phone or email from accounts.db.
// Only an HMAC hash is stored; the plaintext code is never stored, logged or returned. Call issueLoginCode after
// the password check passes.

const CODE_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_10_MIN = 3;
const MAX_SENDS_PER_DAY = 10;
const RESEND_COOLDOWN_MS = 30_000;

export type IssueResult = { ok: true } | { ok: false; reason: "rate_limited" | "cooldown" | "send_failed" };

function secret(): string {
  return authSecret();
}

export function hashCode(code: string, challengeId: string) {
  return crypto.createHmac("sha256", secret()).update(`${challengeId}:${code}`).digest("hex");
}

export function newChallengeId() {
  return crypto.randomBytes(24).toString("hex");
}

export function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Per-user send limit, counted from this user's own login_codes rows. */
function sendAllowed(userId: string, now: number): "ok" | "rate_limited" | "cooldown" {
  const count = (sinceMs: number) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM login_codes WHERE user_id = ? AND created_at > ?`).get(userId, now - sinceMs) as { n: number }).n;
  if (count(24 * 3600_000) >= MAX_SENDS_PER_DAY || count(10 * 60_000) >= MAX_SENDS_PER_10_MIN) return "rate_limited";
  if (count(RESEND_COOLDOWN_MS) > 0) return "cooldown";
  return "ok";
}

async function deliver(code: string, r: { kind: "phone" | "email"; to: string }): Promise<void> {
  if (r.kind === "phone") {
    await sendLoginCode(code, r.to);
    return;
  }
  const account = defaultAccountEmail();
  if (!account) throw new Error("no mail account to send from");
  await sendEmail({
    account,
    to: r.to,
    subject: "Your GenLimitless login code",
    text: `Your GenLimitless login code is ${code}. It expires in 5 minutes. Don't share it.`,
  });
}

/** Issue and send a new code for this user's challenge. Older codes for the challenge are invalidated. */
export async function issueLoginCode(userId: string, challengeId: string, now = Date.now()): Promise<IssueResult> {
  const user = getUser(userId);
  const recipient = user && user.status === "active" ? loginRecipient(user) : null;
  if (!user || !recipient) return { ok: false, reason: "send_failed" };
  const allowed = sendAllowed(userId, now);
  if (allowed !== "ok") return { ok: false, reason: allowed };
  const code = generateCode();
  db.prepare(`UPDATE login_codes SET used_at = ? WHERE challenge_id = ? AND used_at IS NULL`).run(now, challengeId);
  const id = Number(
    db
      .prepare(`INSERT INTO login_codes (user_id, challenge_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(userId, challengeId, hashCode(code, challengeId), now + CODE_TTL_MS, now).lastInsertRowid
  );
  try {
    await deliver(code, recipient);
  } catch {
    db.prepare(`UPDATE login_codes SET used_at = ? WHERE id = ?`).run(now, id);
    return { ok: false, reason: "send_failed" };
  }
  return { ok: true };
}

/** Check a submitted code for this user. Single use; burned after 5 wrong attempts or on expiry. */
export function verifyLoginCode(userId: string, challengeId: string, submitted: string, now = Date.now()): boolean {
  const row = db
    .prepare(
      `SELECT id, code_hash, expires_at, attempts FROM login_codes
       WHERE user_id = ? AND challenge_id = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1`
    )
    .get(userId, challengeId) as { id: number; code_hash: string; expires_at: number; attempts: number } | undefined;
  if (!row) return false;
  if (now > row.expires_at || row.attempts >= MAX_ATTEMPTS) {
    db.prepare(`UPDATE login_codes SET used_at = ? WHERE id = ?`).run(now, row.id);
    return false;
  }
  const a = Buffer.from(hashCode(String(submitted).trim(), challengeId), "hex");
  const b = Buffer.from(row.code_hash, "hex");
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    db.prepare(`UPDATE login_codes SET used_at = ? WHERE id = ?`).run(now, row.id);
    return true;
  }
  const attempts = row.attempts + 1;
  db.prepare(`UPDATE login_codes SET attempts = ?, used_at = CASE WHEN ? >= ? THEN ? ELSE NULL END WHERE id = ?`).run(
    attempts,
    attempts,
    MAX_ATTEMPTS,
    now,
    row.id
  );
  return false;
}
