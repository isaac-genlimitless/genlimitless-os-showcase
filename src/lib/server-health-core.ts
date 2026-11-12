export type HealthStatus = "green" | "yellow" | "red";
export const YELLOW_ABOVE = 75;
export const RED_ABOVE = 90;
export const ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export function pctOf(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
}

export function statusFor(pct: number): HealthStatus {
  if (!Number.isFinite(pct)) return "green";
  return pct > RED_ABOVE ? "red" : pct > YELLOW_ABOVE ? "yellow" : "green";
}

export function worstOf(list: HealthStatus[]): HealthStatus {
  return list.includes("red") ? "red" : list.includes("yellow") ? "yellow" : "green";
}

/** true if no alert was sent for this metric in the last 12 hours */
export function alertDue(lastAtMs: number | null, nowMs: number): boolean {
  return lastAtMs == null || !Number.isFinite(lastAtMs) || nowMs - lastAtMs >= ALERT_COOLDOWN_MS;
}
