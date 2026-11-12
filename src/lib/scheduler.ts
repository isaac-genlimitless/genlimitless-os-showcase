import cron from "node-cron";
import { BUSINESS_TZ, centralMinuteOfDay } from "./time";
import { query } from "@anthropic-ai/claude-agent-sdk";
import db, { logIssue, getState, setState } from "./db";
import { verifyIMessageDeliveries, redactStaleLoginCodes } from "./delivery";
import { nightlySelfTest } from "./selftest";
import { runBriefing, runDailySchedule, runEventPrep, runEveningShutdown, runImprovementReview, runOpsReview, runTriage, runWeeklyReview, triageNeeded } from "./agents/runtime";
import { logActivity } from "./agents/registry";
import { syncPullRequests } from "./github";
import { LOCKED_BASE } from "./agent-lock";
import { isOwnerCell } from "./instance";
import { backupDatabase } from "./backup";
import { checkDiskHealth } from "./disk";
import { runIndexer } from "./msg-index";
import { isCalendarConnected, listEvents } from "./gcal";
import { EVENING_SHUTDOWN_JOB, WEEKLY_REVIEW_JOB, dailyScheduleDue, eventPrepDone, eveningShutdownDue, markDailyScheduleRan, markEventPrepped, markRan, weeklyReviewDue } from "./schedule";

const MODEL = "claude-sonnet-5-5";

/** Resolved fresh on every tick (not captured once at process boot) so a fix that lands on disk
 *  while the dev server is already running takes effect on the very next tick instead of the
 *  server silently running stale in-memory code until a manual restart. See escalation #5. */
export async function runEmailWatchdogTick() {
  const mod = await import("./email-watchdog");
  await mod.runEmailWatchdog();
}

/** Every-minute IMAP outage check (cheap DB read, no IMAP). Dynamic import for the same reason as above. */
export async function runImapDownAlertTick() {
  const mod = await import("./email-watchdog");
  await mod.checkImapDownAlert();
}

/** Every-minute scheduled-text sender (also the catch-up at startup). Dynamic import like the ticks above. */
export async function runScheduledTextsTick() {
  const mod = await import("./scheduled-texts");
  await mod.runScheduledTextsTick();
}

/** @Chief action-mentions on Files pages: runs the ones whose page has been idle 10 minutes.
 *  Dynamic import for the same reason as the ticks above. Overlapping ticks are skipped. */
let chiefTickRunning = false;
export async function runChiefMentionsTick(opts: { boot?: boolean } = {}) {
  if (chiefTickRunning) return;
  chiefTickRunning = true;
  try {
    const mod = await import("./chief-mentions");
    if (opts.boot) mod.recoverMentionsAtBoot();
    await mod.processMentions();
  } catch (err: any) {
    logIssue("scheduler:chief_mentions", "@Chief mention check failed", err.message);
  } finally {
    chiefTickRunning = false;
  }
}

/** Nightly spelling fix on Owner's own Files pages (word-only; see spellfix-core.ts). Dynamic import, overlap-guarded. Idempotent per Central date. */
let spellfixRunning = false;
export async function runSpellfixTick() {
  if (spellfixRunning) return;
  spellfixRunning = true;
  try {
    const mod = await import("./spellfix");
    await mod.runNightlySpellfix();
  } catch (err: any) {
    logIssue("scheduler:spellfix", "Nightly spelling fix failed", err.message);
  } finally {
    spellfixRunning = false;
  }
}

let lastGithubErr = "";
let lastGithubErrAt = 0;
const GITHUB_ERR_REPEAT_MS = 6 * 60 * 60 * 1000;
let started = false;
/** Test hook: lets e2e call startScheduler() again with a different GLOS_ROLE. */
export function __resetSchedulerForTests() { started = false; }

// Catch-up: if the server was asleep at 8:30am, the daily schedule still runs once as soon as it
// wakes (never a silent skip, never a double-run for the same Central date) — checked here, on
// the /15 tick below, and once at startup. dailyScheduleDue() is a cheap DB check, so calling it
// from three places costs nothing except when a run is actually due.
let dailyScheduleRunning = false;
async function runDailyScheduleIfDue(reason: string) {
  if (dailyScheduleRunning || !dailyScheduleDue()) return;
  dailyScheduleRunning = true;
  try {
    await runDailySchedule();
    markDailyScheduleRan();
  } catch (err: any) {
    logIssue("scheduler:daily_schedule", `Daily schedule run failed (${reason})`, err.message);
    // not marked ran: the next catch-up check retries
  } finally {
    dailyScheduleRunning = false;
  }
}

// Evening shutdown (weekdays 6pm) and weekly review (Saturdays 9am): same catch-up shape as the daily
// schedule. Marked ran only after success, so a failure is retried by the next /15 tick that day.
const reviewRunning = new Set<string>();
async function runReviewIfDue(job: string, due: () => boolean, runFn: () => Promise<string>, reason: string) {
  if (reviewRunning.has(job) || !due()) return;
  reviewRunning.add(job);
  try {
    await runFn();
    markRan(job);
  } catch (err: any) {
    logIssue(`scheduler:${job}`, `${job === WEEKLY_REVIEW_JOB ? "Weekly review" : "Evening shutdown"} failed (${reason})`, err.message);
  } finally {
    reviewRunning.delete(job);
  }
}
export const eveningShutdownTick = (reason: string) => runReviewIfDue(EVENING_SHUTDOWN_JOB, eveningShutdownDue, runEveningShutdown, reason);
export const weeklyReviewTick = (reason: string) => runReviewIfDue(WEEKLY_REVIEW_JOB, weeklyReviewDue, runWeeklyReview, reason);

/** Every minute: Autopilot sends that are due (each rechecked against every rule first). */
export async function runAutopilotTick() {
  try {
    await (await import("./autopilot")).runAutopilotTick();
  } catch (err: any) {
    logIssue("scheduler:autopilot", "Autopilot tick failed", err.message);
  }
}

/** Every minute: texts from Owner to the OS become chat turns, answered by text. */
export async function runOwnerTextsTick() {
  try {
    await (await import("./owner-texts")).runOwnerTextsTick();
  } catch (err: any) {
    logIssue("scheduler:owner_texts", "Text-to-Chief tick failed", err.message);
  }
}

/** Every 5 minutes (and at startup): file anything in the capture inbox that hasn't been filed. */
export async function runCapturesTick() {
  try {
    await (await import("./captures")).processPendingCaptures();
  } catch (err: any) {
    logIssue("scheduler:captures", "Capture inbox tick failed", err.message);
  }
}

// Job Description queue: plan 1-2 items and have the Resume Writer prepare them (idempotent; concurrent callers share one run).
async function jdQueueTick(_reason: string) {}

// Phase 2: prep for any meeting starting in the next ~2 hours that hasn't been prepped yet.
// Staggered by the /15 tick itself (never a burst), and "already prepped" is marked before the
// agent runs so an overlapping tick can't double-dispatch the same event.
async function checkEventPrep() {
  if (!(await isCalendarConnected())) return;
  const now = Date.now();
  const events = await listEvents({ timeMin: new Date(now).toISOString(), timeMax: new Date(now + 2 * 3600e3).toISOString() });
  for (const ev of events) {
    if (ev.allDay || ev.status === "cancelled" || eventPrepDone(ev.account, ev.id)) continue;
    markEventPrepped(ev.account, ev.id);
    try {
      await runEventPrep(ev);
    } catch (err: any) {
      logIssue("scheduler:event_prep", `Event prep failed for "${ev.summary}"`, err.message);
    }
  }
}

export function startScheduler() {
  if (started) return;
  started = true;

  // Every 5 minutes (and once shortly after boot, after fix-recovery ran): auto-retry failed fix builds (max 2).
  const retryFixes = async () => {
    try {
      (await import("./fix-retry")).retryFailedFixes();
    } catch (err: any) {
      logIssue("scheduler:fix_retry", "Auto-retry of failed fixes failed", err.message);
    }
  };
  const owner = isOwnerCell(); // member cells skip every owner-only job below (docs/multi-user.md "Member mode")
  if (owner) {
    cron.schedule("*/5 * * * *", retryFixes, { timezone: BUSINESS_TZ });
    setTimeout(retryFixes, 30_000);
  }

  let sending = false;
  // Every minute: retry any email draft Owner already approved that hasn't gone out yet.
  cron.schedule("* * * * *", async () => {
    if (sending) return;
    sending = true;
    try {
      await (await import("./email-drafts")).retryApprovedDrafts(); // only drafts Owner already approved
    }
    catch (err: any) { logIssue("scheduler:send_approved_and_due", "Failed sending due messages", err.message); }
    finally { sending = false; }
  }, { timezone: BUSINESS_TZ });

  // Every 5 minutes: probe each connected mail account's send path (SMTP verify + IMAP NOOP, sends
  // nothing). Keeps one self-resolving issue per outage and alerts Owner once after an hour down.
  cron.schedule("*/5 * * * *", async () => {
    try {
      const mod = await import("./mail-health");
      await mod.runMailHealthProbe();
    } catch (err: any) {
      logIssue("scheduler:mail_health", "Mail health probe failed", err.message);
    }
  }, { timezone: BUSINESS_TZ });

  // Every minute: confirm recent iMessages actually delivered; retry / escalate if not.
  if (owner) cron.schedule("* * * * *", async () => {
    try {
      await verifyIMessageDeliveries();
      redactStaleLoginCodes();
    } catch (err: any) {
      logIssue("scheduler:verify_imessages", "iMessage delivery check failed", err.message);
    }
  }, { timezone: BUSINESS_TZ });

  // Every minute: send queued texts to Owner whose time has come (send-once claim, retry, failure alert). Anything missed while the server was down goes out on the first tick.
  if (owner) cron.schedule("* * * * *", async () => {
    try {
      await runScheduledTextsTick();
    } catch (err: any) {
      logIssue("scheduler:scheduled_texts", "Scheduled text check failed", err.message);
    }
  }, { timezone: BUSINESS_TZ });
  if (owner) void runScheduledTextsTick().catch((err: any) => logIssue("scheduler:scheduled_texts", "Scheduled text startup catch-up failed", err.message));

  // Every 2 minutes: new GitHub pull requests show up in the OS chat.
  if (owner) cron.schedule("*/2 * * * *", async () => {
    try {
      await syncPullRequests();
      lastGithubErr = "";
      lastGithubErrAt = 0;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const now = Date.now();
      if (msg !== lastGithubErr || now - lastGithubErrAt > GITHUB_ERR_REPEAT_MS) {
        lastGithubErr = msg;
        lastGithubErrAt = now;
        logIssue("scheduler:github_prs", "Couldn't sync GitHub pull requests", msg);
      }
    }
  }, { timezone: BUSINESS_TZ });

  const linkedInTick = async () => {};
  if (owner) {
    cron.schedule("10,40 7-21 * * *", linkedInTick, { timezone: BUSINESS_TZ });
    setTimeout(linkedInTick, 60_000);
  }

  // Hourly: warn Owner (once per 24h) when free disk is too low to back up the database.
  if (owner) cron.schedule("0 * * * *", async () => {
    try {
      await checkDiskHealth();
    } catch (err: any) {
      logIssue("scheduler:disk_health", "Disk health check failed", err.message);
    }
  }, { timezone: BUSINESS_TZ });

  // Every 10 minutes: The Creation's autonomous agents. Starts the oldest due mission (queued "now" or
  // "tonight") if none is running. Each mission works only in its own sandbox, under the 1M-token cap.
  cron.schedule("*/10 * * * *", async () => {
    try { const { runDueMissions } = await import("./creations/missions"); await runDueMissions(); }
    catch (err) { logIssue("scheduler:creation_missions", "Creation agent mission failed to run", (err as Error).message); }
  }, { timezone: BUSINESS_TZ });

  // Every 15 minutes: if server memory or disk is over 90%, log one issue and text Owner (max once per 12h per metric). Read-only; never deletes anything.
  if (owner) cron.schedule("*/15 * * * *", async () => {
    try { const mod = await import("./server-health-alert"); await mod.checkServerHealthAlerts(); }
    catch (err: any) { logIssue("scheduler:server_health", "Server health check failed", err.message); }
    // Old-release cleanup: after a new successful deploy, otherwise as a routine check. Only old release folders are deleted.
    try {
      const { runReleaseCleanup } = await import("./release-cleanup");
      const { readDeployStatus } = await import("./deploy");
      const st = readDeployStatus();
      const lastSha = getState("release_cleanup:last_deploy_sha");
      if (st?.state === "done" && st.sha && st.sha !== lastSha) {
        runReleaseCleanup("after-deploy");
        setState("release_cleanup:last_deploy_sha", st.sha);
      } else {
        runReleaseCleanup("health-check");
      }
    } catch (err: any) {
      logIssue("scheduler:release_cleanup", "Old-release cleanup failed", err.message);
    }
    // Old pre-deploy DB snapshots in backups/: keep the newest 3 (never the newest) plus any for the current/previous release.
    try { const { pruneDeployBackups } = await import("./backup-prune"); pruneDeployBackups(); }
    catch (err: any) { logIssue("scheduler:backup_prune", "Pre-deploy backup pruning failed", err.message); }
  }, { timezone: BUSINESS_TZ });

  // Once, ~2 minutes after boot (every successful deploy restarts the server).
  if (owner) setTimeout(async () => {
    try { const { runReleaseCleanup } = await import("./release-cleanup"); runReleaseCleanup("after-deploy"); }
    catch (err: any) { logIssue("scheduler:release_cleanup", "Old-release cleanup failed", err.message); }
  }, 120000);

  // Hourly: backstop watchdog for the real-time email pipeline (stuck replies, overdue sends,
  // a dead IMAP watch, drafts sitting too long unapproved). Texts Owner if anything's stuck.
  cron.schedule("0 * * * *", async () => {
    try {
      await runEmailWatchdogTick();
    } catch (err: any) {
      logIssue("scheduler:email_watchdog", "Email watchdog failed", err.message);
    }
  }, { timezone: BUSINESS_TZ });

  // Every minute: text Owner once if the IMAP watch has been down 15+ min (and once when it's back).
  cron.schedule("* * * * *", async () => {
    try {
      await runImapDownAlertTick();
    } catch (err: any) {
      logIssue("scheduler:imap_down_alert", "IMAP down alert check failed", err.message);
    }
  }, { timezone: BUSINESS_TZ });

  // On startup: if the server was asleep at 8:30am, catch up on today's daily schedule right
  // away instead of waiting for the next /15 tick.
  void runDailyScheduleIfDue("startup").then(() => undefined);

  // Nightly 2:00am Central: fix misspelled words (words only) on pages Owner created. Runs before the 2:15 backup so the backup holds the result.
  cron.schedule("0 2 * * *", () => void runSpellfixTick(), { timezone: BUSINESS_TZ });
  // Catch-up if the server was asleep at 2:00 (runNightlySpellfix is a no-op once today's run is done).
  if (centralMinuteOfDay() >= 120) void runSpellfixTick();

  // On startup, and nightly 2:15am Central: back up the whole database. Runs immediately here
  // too so a fresh install/restart is never more than one backup-interval away from a snapshot.
  void backupDatabase();
  cron.schedule("15 2 * * *", async () => {
    await backupDatabase();
  }, { timezone: BUSINESS_TZ });

  // Nightly 2:30am Central: click through the app like Owner would and flag anything broken.
  if (owner) cron.schedule("30 2 * * *", async () => {
    try {
      await nightlySelfTest();
    } catch (err: any) {
      logIssue("scheduler:nightly_selftest", "Nightly self-test couldn't run", err.message);
    }
  }, { timezone: BUSINESS_TZ });

  // Daily 8:00am Central: the Full Stack Engineer works the open-issues list (after the nightly
  // tests have run); its proposals go to the Chief of Staff for review.
  if (owner) cron.schedule("0 8 * * *", async () => {
    try {
      await runOpsReview();
    } catch (err: any) {
      logIssue("scheduler:ops_review", "Daily ops review failed", err.message);
    }
  }, { timezone: BUSINESS_TZ });

  // Daily 7:45am Central (before the 8:30 briefing): Chief checks every open task against mail,
  // texts, Files pages and what's been built, and closes the ones that are provably done.
  cron.schedule("45 7 * * *", async () => {
    try {
      const { runTaskReconcile } = await import("./task-reconcile");
      await runTaskReconcile({ reason: "scheduled 7:45" });
    } catch (err: any) {
      logIssue("scheduler:task_reconcile", "Daily task reconcile failed", err.message);
    }
  }, { timezone: BUSINESS_TZ });

  // Daily 8:30am Central: read Owner's whole world and propose today's schedule (a review card
  // in chat — nothing written to any calendar until he approves each block), then the Chief of
  // Staff's morning briefing. runDailyScheduleIfDue is idempotent, so this is also exactly what
  // fires (once) if the server was asleep at 8:30 — see the /15 tick and the startup call below.
  cron.schedule("30 8 * * *", async () => {
    await runDailyScheduleIfDue("scheduled 8:30");
    if (owner) await jdQueueTick("scheduled 8:30");
    try {
      await runBriefing();
    } catch (err: any) {
      logIssue("scheduler:briefing", "Morning briefing failed", err.message);
    }
  }, { timezone: BUSINESS_TZ });

  // Every 15 minutes: if anything is waiting on the Chief of Staff (important escalations,
  // code to review), wake it. Critical escalations wake it immediately instead. Also the
  // catch-up check for a missed 8:30 daily schedule, and phase-2 meeting prep.
  cron.schedule("*/15 * * * *", async () => {
    try {
      if (triageNeeded()) await runTriage("scheduled check");
    } catch (err: any) {
      logIssue("scheduler:triage", "Chief of Staff triage failed", err.message);
    }
    await runDailyScheduleIfDue("/15 tick");
    if (owner) void jdQueueTick("/15 tick");
    try {
      await checkEventPrep();
    } catch (err: any) {
      logIssue("scheduler:event_prep", "Event prep check failed", err.message);
    }
  }, { timezone: BUSINESS_TZ });

  // Weekdays 6:00pm Central: evening shutdown. Saturdays 9:00am Central: weekly review. Both are
  // also checked on the /15 tick and at startup (catch-up the same day if the server was asleep).
  cron.schedule("0 18 * * 1-5", () => void eveningShutdownTick("scheduled 6pm"), { timezone: BUSINESS_TZ });
  cron.schedule("0 9 * * 6", () => void weeklyReviewTick("scheduled Saturday 9am"), { timezone: BUSINESS_TZ });
  cron.schedule("*/15 * * * *", () => {
    void eveningShutdownTick("/15 catch-up");
    void weeklyReviewTick("/15 catch-up");
  }, { timezone: BUSINESS_TZ });
  setTimeout(() => {
    void eveningShutdownTick("startup catch-up");
    void weeklyReviewTick("startup catch-up");
  }, 90_000);

  // Every minute: Autopilot sends that are due, and texts from Owner to Chief.
  cron.schedule("* * * * *", () => void runAutopilotTick(), { timezone: BUSINESS_TZ });
  if (owner) cron.schedule("* * * * *", () => void runOwnerTextsTick(), { timezone: BUSINESS_TZ });
  // Capture inbox: every 5 minutes and once at startup (captures normally file right away).
  cron.schedule("*/5 * * * *", () => void runCapturesTick(), { timezone: BUSINESS_TZ });
  setTimeout(() => void runCapturesTick(), 60_000);

  // Nightly 9:00pm Central: the Chief of Staff turns the day's feedback into better agents.
  cron.schedule("0 21 * * *", async () => {
    try {
      await runImprovementReview();
    } catch (err: any) {
      logIssue("scheduler:improvement_review", "Nightly improvement review failed", err.message);
    }
  }, { timezone: BUSINESS_TZ });

  // Keep the message-search index current (first run builds it in the background, then it's
  // one cheap query a minute). Never blocks the server: it works in small batches.
  if (owner) {
    void runIndexer(); // indexes the owner's Apple Messages
    cron.schedule("* * * * *", () => void runIndexer(), { timezone: BUSINESS_TZ });
  }

  // @Chief action-mentions: every minute, run any whose page has been idle for 10 minutes; once at
  // startup too (recover interrupted runs first, then catch up).
  void runChiefMentionsTick({ boot: true });
  cron.schedule("* * * * *", () => void runChiefMentionsTick(), { timezone: BUSINESS_TZ });

  // Inbound sweep: every 15 minutes (and once at startup) hand all new texts + mail to Chief.
  const sweepTick = async (reason: string) => {
    try {
      const { runInboundSweep } = await import("./inbound-sweep");
      await runInboundSweep({ reason });
    } catch (err: any) {
      logIssue("scheduler:inbound_sweep", "Inbound sweep tick failed", err.message);
    }
  };
  cron.schedule("*/15 * * * *", () => void sweepTick("scheduled"), { timezone: BUSINESS_TZ });
  void sweepTick("startup catch-up");
  cron.schedule("7,37 * * * *", async () => {
    try {
      const { checkSweepHealth } = await import("./inbound-sweep");
      await checkSweepHealth();
    } catch (err: any) {
      logIssue("scheduler:inbound_sweep_health", "Inbound sweep health check failed", err.message);
    }
  }, { timezone: BUSINESS_TZ });

  // Recurring agent schedules (Settings > Agent schedules): every minute, and once at startup as the catch-up.
  const agentSchedulesTick = async (reason: string) => {
    try { await (await import("./agent-schedules")).runAgentSchedulesTick(reason); }
    catch (err: any) { logIssue("scheduler:agent_schedules", "Agent schedules tick failed", err.message); }
  };
  void agentSchedulesTick("startup catch-up");
  cron.schedule("* * * * *", () => void agentSchedulesTick("scheduled"), { timezone: BUSINESS_TZ });
  console.log("[scheduler] started");
}
