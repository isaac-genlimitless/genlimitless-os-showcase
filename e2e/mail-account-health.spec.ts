import { test, expect } from "./isolated-test";
import { openTestDb } from "./db-handle";
import { nextBackoff, withJitter, shouldLogDrop } from "../src/lib/imap-idle";
import { decideImapAlert } from "../src/lib/email-watchdog";
import { classifyWatchHealth } from "../src/lib/mail-accounts";

// Regression tests for the business-mailbox IMAP watch outage: Analytics used to say
// "Connected (legacy app password)" even while the watch was down, the reconnect backoff was
// never reset, and an outage was texted 20-80 min late. Nothing here presses Send, triggers an
// agent, or touches IMAP: the UI test seeds imap_watch_state in the isolated test DB, and the
// logic tests call the pure helpers with an explicit "now" (no real timers needed).

const MIN = 60_000;

test.describe("reconnect backoff", () => {
  test("doubles 5s -> 10s -> 20s ... and caps at 2 minutes", () => {
    let b = 5_000;
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      seen.push(b);
      b = nextBackoff(b, 0);
    }
    expect(seen).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000]);
  });

  test("a session that stayed healthy over 60s resets the backoff to 5s", () => {
    expect(nextBackoff(120_000, 61_000)).toBe(5_000);
    expect(nextBackoff(120_000, 59_000)).toBe(120_000);
  });

  test("jitter stays within +/-20%", () => {
    expect(withJitter(10_000, () => 0)).toBe(8_000);
    expect(withJitter(10_000, () => 1)).toBe(12_000);
  });

  test("drops are only logged as issues on the first drop, then every 6h", () => {
    const now = Date.now();
    expect(shouldLogDrop(null, undefined, now)).toBe(true); // first drop of an outage
    expect(shouldLogDrop(now - 20 * MIN, now - 20 * MIN, now)).toBe(false); // repeat drop
    expect(shouldLogDrop(now - 7 * 60 * MIN, now - 7 * 60 * MIN, now)).toBe(true); // still down 6h+ later
    expect(shouldLogDrop(now - 7 * 60 * MIN, undefined, now)).toBe(true); // after a server restart
  });
});

test.describe("15-minute down alert fires once per outage", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const ago = (min: number) => new Date(now - min * MIN).toISOString().slice(0, 19).replace("T", " ");

  test("no alert before 15 min, alert after, never a second alert", () => {
    expect(decideImapAlert({ status: "error", down_since: ago(5), down_alerted_at: null }, now)).toBeNull();
    expect(decideImapAlert({ status: "error", down_since: ago(14), down_alerted_at: null }, now)).toBeNull();
    expect(decideImapAlert({ status: "error", down_since: ago(16), down_alerted_at: null }, now)).toBe("alert");
    expect(decideImapAlert({ status: "error", down_since: ago(90), down_alerted_at: ago(74) }, now)).toBeNull();
  });

  test("'back up' text only if an alert had been sent", () => {
    expect(decideImapAlert({ status: "watching", down_since: null, down_alerted_at: ago(3) }, now)).toBe("recovered");
    expect(decideImapAlert({ status: "watching", down_since: null, down_alerted_at: null }, now)).toBeNull();
  });
});

test.describe("watch health classification", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const ago = (min: number) => new Date(now - min * MIN).toISOString().slice(0, 19).replace("T", " ");

  test("healthy, reconnecting, down, and credentials failures", () => {
    const ok = classifyWatchHealth({ status: "watching", last_ok_at: ago(1), down_since: null, last_error: null }, now);
    expect(ok.state).toBe("ok");
    const blip = classifyWatchHealth({ status: "error", last_ok_at: ago(8), down_since: ago(3), last_error: "Connection not available" }, now);
    expect(blip.state).toBe("reconnecting");
    const down = classifyWatchHealth({ status: "error", last_ok_at: ago(40), down_since: ago(20), last_error: "Connection not available" }, now);
    expect(down.state).toBe("down");
    const creds = classifyWatchHealth({ status: "error", last_ok_at: null, down_since: ago(1), last_error: "Invalid credentials (Failure)" }, now);
    expect(creds.state).toBe("down");
    expect(creds.reason).toBe("credentials");
  });
});

test.describe("Analytics shows live mailbox health", () => {
  let account: string | null = null;

  test.beforeEach(async ({ request }) => {
    const res = await request.get("/api/mail-accounts");
    const data = await res.json();
    account = data.accounts.find((a: any) => a.kind === "legacy_app_password")?.email ?? null;
    test.skip(!account, "no app-password mail account configured in this test env");
  });

  function seed(sql: string, ...params: unknown[]) {
    const db = openTestDb();
    try {
      db.prepare(sql).run(...params);
    } finally {
      db.close();
    }
  }

  test("a down watch says 'Down since' and never 'Connected'", async ({ page }) => {
    seed(
      `INSERT INTO imap_watch_state (account, last_uid, status, last_seen_at, last_ok_at, last_error, down_since, consecutive_failures, updated_at)
       VALUES (?, 0, 'error', datetime('now','-40 minutes'), datetime('now','-40 minutes'), 'Connection not available', datetime('now','-20 minutes'), 5, datetime('now'))
       ON CONFLICT(account) DO UPDATE SET status='error', last_ok_at=excluded.last_ok_at, last_error=excluded.last_error,
         down_since=excluded.down_since, consecutive_failures=5, down_alerted_at=NULL`,
      account
    );
    await page.goto("/analytics");
    const health = page.getByTestId("mail-health").first();
    await expect(health).toContainText("Down since");
    await expect(health).not.toContainText("Connected");
  });

  test("a healthy watch says 'Watching'", async ({ page }) => {
    seed(
      `INSERT INTO imap_watch_state (account, last_uid, status, last_seen_at, last_ok_at, last_error, down_since, consecutive_failures, updated_at)
       VALUES (?, 0, 'watching', datetime('now','-1 minutes'), datetime('now','-1 minutes'), NULL, NULL, 0, datetime('now'))
       ON CONFLICT(account) DO UPDATE SET status='watching', last_ok_at=excluded.last_ok_at, last_seen_at=excluded.last_seen_at,
         last_error=NULL, down_since=NULL, consecutive_failures=0, down_alerted_at=NULL`,
      account
    );
    await page.goto("/analytics");
    await expect(page.getByTestId("mail-health").first()).toContainText("Watching");
  });
});
