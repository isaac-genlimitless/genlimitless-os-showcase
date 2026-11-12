// Pure: the 1M-token rules for The Creation's agents.
import { test, expect } from "@playwright/test";
import { billed, HARD_CAP, MIN_START, planBudget, remaining, shouldStop, TURN_FLOOR } from "../src/lib/creations/budget";

test("the cap counts every billed token and reserved spend", () => {
  expect(HARD_CAP).toBe(1_000_000);
  expect(billed({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBe(10);
  expect(remaining(600_000, 300_000)).toBe(100_000);
  expect(remaining(900_000, 300_000)).toBe(0);
});

test("a mission's budget comes only from what's left, and too little refuses to start", () => {
  expect(planBudget(undefined, 1_000_000)).toEqual({ ok: true, budget: 150_000 });
  expect(planBudget(9_999_999, 1_000_000)).toEqual({ ok: true, budget: 400_000 });
  expect(planBudget(300_000, 120_000)).toEqual({ ok: true, budget: 120_000 });
  const r = planBudget(100_000, MIN_START - 1);
  expect(r.ok).toBe(false);
});

test("the run stops BEFORE a call that could cross its budget", () => {
  expect(shouldStop(0, 100_000, 0)).toBe(false);
  expect(shouldStop(100_000 - TURN_FLOOR, 100_000, 1_000)).toBe(false);
  expect(shouldStop(100_000 - TURN_FLOOR + 1, 100_000, 1_000)).toBe(true);
  // last call 40k → next assumed 60k
  expect(shouldStop(40_000, 100_000, 40_000)).toBe(false);
  expect(shouldStop(40_001, 100_000, 40_000)).toBe(true);
});
