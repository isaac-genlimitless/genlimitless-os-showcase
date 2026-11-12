// Token budget rules for The Creation's autonomous agents. Pure; no I/O.
//
// Owner's rule: creation agents never go over 1,000,000 tokens. Enforced as a HARD cap on everything
// they spend in any rolling 24 hours (all missions together), counting every billed token: input,
// output, cache reads and cache writes. A mission gets a budget only from what's left, and its run
// stops BEFORE a model call that could cross its budget (projected from the last call's size).

export const HARD_CAP = 1_000_000;
export const DEFAULT_MISSION = 150_000;
export const MAX_MISSION = 400_000;
export const MIN_START = 20_000; // not worth starting with less than this
/** Smallest amount a single model call is assumed to cost when projecting the next one. */
export const TURN_FLOOR = 15_000;

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
export const billed = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite;

/** What's left under the hard cap right now: cap − spent in the last 24h − what running missions may still spend. */
export function remaining(spent24h: number, reservedByRunning: number): number {
  return Math.max(0, HARD_CAP - spent24h - reservedByRunning);
}

/** The budget a new mission actually gets, or why it can't start. */
export function planBudget(requested: number | undefined, available: number): { ok: true; budget: number } | { ok: false; reason: string } {
  const want = Number.isFinite(requested) && (requested as number) > 0 ? Math.min(MAX_MISSION, Math.floor(requested as number)) : DEFAULT_MISSION;
  const budget = Math.min(want, available);
  if (budget < MIN_START) {
    return { ok: false, reason: `Only ${available.toLocaleString()} of the ${HARD_CAP.toLocaleString()}-token daily cap is left; a mission needs at least ${MIN_START.toLocaleString()}. Try again later.` };
  }
  return { ok: true, budget };
}

/**
 * Stop before the next model call if it could cross the budget. The next call is assumed to cost at
 * least 1.5× the last one (context grows each turn) and never less than TURN_FLOOR.
 */
export function shouldStop(used: number, budget: number, lastCall: number): boolean {
  const next = Math.max(TURN_FLOOR, Math.ceil(lastCall * 1.5));
  return used + next > budget;
}
