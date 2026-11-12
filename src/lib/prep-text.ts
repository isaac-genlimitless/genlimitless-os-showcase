import db, { logIssue } from "./db";
export const ACTIVE_WINDOW_MIN = 15;

/** Pure: active if any signal is within the window. Times are ms epoch (null = never). */
export function isActiveFrom(nowMs: number, signalsMs: (number | null)[], windowMin = ACTIVE_WINDOW_MIN): boolean {
  return signalsMs.some((t) => t != null && nowMs - t < windowMin * 60_000);
}

export function isOwnerActive(nowMs = Date.now()): boolean {
  const s = db.prepare(`SELECT MAX(last_seen_at) t FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ?`).get(nowMs) as { t: number | null };
  const c = db.prepare(`SELECT MAX(created_at) t FROM chat_history WHERE role='user'`).get() as { t: string | null };
  const chatMs = c.t ? new Date(c.t.replace(" ", "T") + "Z").getTime() : null;
  return isActiveFrom(nowMs, [s.t, chatMs]);
}

/** Pure: plain-text, key point first, always < 300 chars. */
export function buildPrepText(summary: string, startLabel: string, note: string): string {
  const plain = note.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  const head = `${summary} (${startLabel}): `;
  const room = 299 - head.length;
  const body = plain.length > room ? plain.slice(0, Math.max(0, room - 1)).trimEnd() + "…" : plain;
  return (head + body).slice(0, 299);
}

/** Text Owner (only) the prep note if he is inactive. Never throws; never blocks the chat post. */
export async function textPrepIfInactive(summary: string, startLabel: string, note: string): Promise<"sent" | "active" | "skipped"> {
  try {
    if (isOwnerActive()) return "active";
    const to = process.env.OWNER_IMESSAGE_HANDLE || "";
    if (!to) { logIssue("prep_text", "Prep text skipped: OWNER_IMESSAGE_HANDLE not set"); return "skipped"; }
    const { trackedIMessage } = await import("./delivery");
    await trackedIMessage({ to, text: buildPrepText(summary, startLabel, note), purpose: "alert" });
    return "sent";
  } catch (e: any) {
    logIssue("prep_text", `Prep text failed for "${summary}"`, e?.message);
    return "skipped";
  }
}
