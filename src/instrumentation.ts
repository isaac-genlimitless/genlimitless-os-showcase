export async function register() {
  process.env.TZ = "America/Chicago"; // GenLimitless runs on Central Time

  // Test servers (engineer branches) set DISABLE_SCHEDULER so they never send email,
  // text Owner, or watch a real mailbox.
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.DISABLE_SCHEDULER) {
    // Member cells (GLOS_ROLE=member) never start owner-only work: self-build, deploy/server ops, the owner's
    // iMessage/job-engine/LinkedIn bridges. See docs/multi-user.md "Member mode" and the table in src/lib/scheduler.ts.
    const { isOwnerCell } = await import("./lib/instance");
    const owner = isOwnerCell();
    if (owner) import("./lib/keep-previous-static").then((m) => m.keepPreviousStatic()).catch(() => {}); // phones holding the previous build's page keep working after a deploy
    // Once per process: the in-memory fix queue is empty at boot, so any 'applying' fix is stale.
    const g = globalThis as { __fixRecoveryDone?: boolean };
    if (owner && !g.__fixRecoveryDone) {
      g.__fixRecoveryDone = true;
      try {
        const { recoverStuckFixes } = await import("./lib/fix-recovery");
        recoverStuckFixes();
      } catch (e) {
        console.error("recoverStuckFixes failed", e);
      }
    }
    (await import("./lib/loop-lag")).startLoopLagMonitor();
    if (owner) (await import("./lib/fix-overlap")).startOverlapWatch();
    // Indexes for the scheduler's and pages' hot queries (one-time; backs up first if any are missing).
    try {
      await (await import("./lib/db-indexes")).ensureIndexesAtStartup();
    } catch (e) {
      console.error("ensureIndexes failed", e);
    }
    // Fire-and-forget: log an issue at boot if the headless test browser can't launch.
    if (owner) import("./lib/selftest").then((m) => m.checkBrowserLaunch()).catch(() => {});
    const { startScheduler } =await import("./lib/scheduler");
    startScheduler();
    if (owner) {
      const { startCleanupCron } = await import("./lib/cleanup-cron");
      startCleanupCron();
      const { startPrConflictWatch } = await import("./lib/pr-conflict-watch");
      startPrConflictWatch();
      (await import("./lib/fix-deps")).startFixDepsWatch();
      const { startAutoMerge } = await import("./lib/auto-merge-server");
      startAutoMerge();
    }
    const { startImapIdleWatchers } = await import("./lib/imap-idle");
    startImapIdleWatchers();
    if (owner) (await import("./lib/fix-pr-status")).startFixPrStatusWatch();
  }
}
