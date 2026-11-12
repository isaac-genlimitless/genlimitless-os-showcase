import { test, expect } from "./isolated-test";
import fs from "fs";
import path from "path";
import { EVENING_SHUTDOWN_JOB, WEEKLY_REVIEW_JOB, eveningShutdownDue, markRan, weeklyReviewDue } from "../src/lib/schedule";

// Evening shutdown (weekdays 6pm Central) and the weekly review (SATURDAYS 9am Central).
// Pure date logic + cron registration with a stub: no handler ever runs, no agent, no sends.

// Dates in Nov 2030 (CST) so no other spec or run ever marks them ran.

test("weekly review is due on Saturday from 9am Central, once per Saturday, never Sunday", () => {
  expect(weeklyReviewDue(new Date("2030-11-09T14:59:00Z"))).toBe(false); // Sat 8:59am CST
  expect(weeklyReviewDue(new Date("2030-11-09T15:00:00Z"))).toBe(true); // Sat 9:00am CST
  expect(weeklyReviewDue(new Date("2030-11-10T16:00:00Z"))).toBe(false); // Sunday
  expect(weeklyReviewDue(new Date("2030-11-08T16:00:00Z"))).toBe(false); // Friday
  markRan(WEEKLY_REVIEW_JOB, new Date("2030-11-09T15:00:00Z"));
  expect(weeklyReviewDue(new Date("2030-11-09T20:00:00Z"))).toBe(false);
});

test("evening shutdown is due weekdays from 6pm Central, once a day, not weekends", () => {
  expect(eveningShutdownDue(new Date("2030-11-06T23:59:00Z"))).toBe(false); // Wed 5:59pm CST
  expect(eveningShutdownDue(new Date("2030-11-07T00:00:00Z"))).toBe(true); // Wed 6:00pm CST
  expect(eveningShutdownDue(new Date("2030-11-10T01:00:00Z"))).toBe(false); // Sat 7pm
  markRan(EVENING_SHUTDOWN_JOB, new Date("2030-11-07T00:00:00Z"));
  expect(eveningShutdownDue(new Date("2030-11-07T02:00:00Z"))).toBe(false);
});

test("crons: Saturday 9am weekly review, weekday 6pm shutdown, Autopilot + text-Chief every minute", () => {
  // Read the source (startScheduler only runs once per process, and scheduler-crons.spec may already have called it).
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/scheduler.ts"), "utf8");
  expect(src).toMatch(/cron\.schedule\("0 9 \* \* 6", \(\) => void weeklyReviewTick/);
  expect(src).toMatch(/cron\.schedule\("0 18 \* \* 1-5", \(\) => void eveningShutdownTick/);
  expect(src).toMatch(/cron\.schedule\("\* \* \* \* \*", \(\) => void runAutopilotTick\(\)/);
  expect(src).toMatch(/cron\.schedule\("\* \* \* \* \*", \(\) => void runOwnerTextsTick\(\)/);
  expect(src).not.toMatch(/cron\.schedule\("[^"]* 0", \(\) => void weeklyReviewTick/); // never Sunday
});
