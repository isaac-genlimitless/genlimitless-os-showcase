import { test, expect } from "./isolated-test";
import cron from "node-cron";
import { startScheduler } from "../src/lib/scheduler";

// Node-only: records cron.schedule calls with a stub. Never sends or runs an agent (handlers are never invoked).
test("no outreach crons exist; approved-email retry and the inbound sweep are registered", () => {
  const calls: { expr: string; src: string }[] = [];
  const orig = cron.schedule;
  const origTimeout = global.setTimeout;
  (cron as any).schedule = (expr: string, fn: unknown) => {
    calls.push({ expr, src: String(fn) });
    return { stop() {}, start() {} };
  };
  // Don't let boot-time timers fire real work.
  (global as any).setTimeout = () => 0;
  try {
    startScheduler();
  } finally {
    (cron as any).schedule = orig;
    global.setTimeout = origTimeout;
  }
  const has = (needle: string) => calls.some((c) => c.src.includes(needle));
  for (const gone of ["runInboundTextsPass", "draftDueFollowups", "checkEmailBounces", "runReplyReconcileTick", "runProspectingPass", "runScheduledProspectingPass", "sendApprovedAndDue"]) {
    expect(has(gone)).toBe(false);
  }
  expect(calls.some((c) => c.expr === "* * * * *" && c.src.includes("retryApprovedDrafts"))).toBe(true);
  expect(calls.some((c) => c.expr === "*/15 * * * *")).toBe(true);
});
