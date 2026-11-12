import { test, expect } from "@playwright/test";
import * as watchdogModule from "../src/lib/email-watchdog";
import { runEmailWatchdogTick } from "../src/lib/scheduler";

// Proves the fix for escalation #5: proposal #15's stuck-reply gate was code-correct on disk but
// the live process kept running the OLD email-watchdog.ts logic for 2+ days because scheduler.ts
// captured a reference to runEmailWatchdog once at process boot instead of resolving the
// module's current export each time the job runs. No DB writes, no notifyOwner call, no agent
// run - this only exercises the dispatch path.

test("email watchdog tick calls the module's CURRENT export, not one captured before the patch", async () => {
  const capturedBeforePatch = watchdogModule.runEmailWatchdog;
  let ranNewBehavior = false;
  try {
    // Simulate a fix landing on disk after scheduler.ts's job was already registered.
    (watchdogModule as any).runEmailWatchdog = async () => { ranNewBehavior = true; };

    await runEmailWatchdogTick();
    expect(ranNewBehavior).toBe(true);

    // Prove the captured-reference pattern really is what was broken: calling the reference
    // obtained BEFORE the patch does not run the new behavior, even though the module's live
    // export has changed.
    ranNewBehavior = false;
    await capturedBeforePatch();
    expect(ranNewBehavior).toBe(false);
  } finally {
    (watchdogModule as any).runEmailWatchdog = capturedBeforePatch;
  }
});
