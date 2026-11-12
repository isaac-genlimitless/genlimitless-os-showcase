// Pure helpers for self-healing sends (no DB, no network) so they can be unit tested.

export const MAX_SEND_ATTEMPTS = 12;

/** Minutes to wait after the Nth failed attempt (attempts is the count AFTER incrementing, >= 1):
 *  5, 10, 20, 40, 60, 60... Capped at 60. */
export function backoffMinutes(attempts: number): number {
  return Math.min(5 * 2 ** Math.max(0, attempts - 1), 60);
}

/** Backoff with +/-20% jitter. `rand` is injectable (0..1) for tests. */
export function backoffWithJitter(attempts: number, rand: number = Math.random()): number {
  return backoffMinutes(attempts) * (0.8 + 0.4 * rand);
}

/** SQLite datetime() modifier for the next retry. */
export function nextRetryModifier(attempts: number): string {
  if (attempts >= MAX_SEND_ATTEMPTS) return "+60 minutes"; // capped: stays approved, flagged for Owner
  return `+${Math.max(1, Math.round(backoffWithJitter(attempts) * 60))} seconds`;
}
