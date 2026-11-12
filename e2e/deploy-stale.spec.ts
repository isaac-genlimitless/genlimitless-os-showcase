import { test, expect } from "@playwright/test";
import { staleAware } from "../src/lib/deploy-stale";

const now = Date.parse("2026-10-20T23:00:00Z");
const mk = (state: string, minsAgo: number | string) => ({
  state,
  message: "Compiling abc",
  sha: "abc",
  at: typeof minsAgo === "string" ? minsAgo : new Date(now - minsAgo * 60000).toISOString(),
});

test("recent running stays running", () => {
  const s = mk("running", 5);
  expect(staleAware(s, now)).toEqual(s);
});

test("old running becomes failed and names the step", () => {
  const r = staleAware(mk("running", 45), now)!;
  expect(r.state).toBe("failed");
  expect(r.message).toContain("Compiling abc");
});

test("old done/failed unchanged", () => {
  for (const st of ["done", "failed"]) {
    const s = mk(st, 300);
    expect(staleAware(s, now)).toEqual(s);
  }
});

test("bad date unchanged, null stays null", () => {
  const s = mk("running", "not a date");
  expect(staleAware(s, now)).toEqual(s);
  expect(staleAware(null, now)).toBeNull();
});
