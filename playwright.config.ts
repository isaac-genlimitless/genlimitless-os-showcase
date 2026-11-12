import { defineConfig } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

// Default: run against the already-running dev server (E2E_BASE_URL, default :3100). Specs
// that only READ (Messages, real inboxes, Analytics) belong here, since they need Owner's
// real data to mean anything.
//
// E2E_START_SERVER=1 (engineer branches, CI): boot a throwaway server on :3200 with the
// scheduler disabled AND its own empty data directory (GENLIMITLESS_DATA_DIR — see
// src/lib/data-dir.ts), so specs that create schools/messages/chat rows (campaign-review,
// campaign-tab, inbound-email, docs, text-drafts, ...) can never write into Owner's real
// database. Before this, those specs wrote straight into data/genlimitless.db whenever they
// ran here, on :3100, or in CI (which shared the same data/ folder) — leaving fake "E2E ..."
// schools and drafts in Owner's live OS.
const startServer = !!process.env.E2E_START_SERVER;
// Ports are overridable so two worktrees (or a worktree and the main checkout) can run the branch suite at once.
// reuseExistingServer is on, so without distinct ports a run silently talks to the OTHER checkout's server.
const OWNER_PORT = Number(process.env.E2E_PORT) || 3200;
const MEMBER_PORT = Number(process.env.E2E_MEMBER_PORT) || 3210;

// Playwright evaluates this file in the runner AND in every worker. The runner makes the temp dir
// and exports it; workers inherit that env and reuse it, so specs that open the DB directly (via
// e2e/db-handle.ts, or by importing src/lib modules) see the same data the :3200 server does.
// UNCONDITIONAL: even a plain `npx playwright test` against :3100 gives the runner and workers a throwaway DB
// (the :3100 server is a separate process, unaffected). An inherited non-test path is ignored.
let isolatedDataDir: string | undefined;
{
  const inherited = process.env.GENLIMITLESS_DATA_DIR;
  isolatedDataDir =
    inherited && path.basename(inherited).startsWith("genlimitless-e2e-data-")
      ? inherited
      : fs.mkdtempSync(path.join(os.tmpdir(), "genlimitless-e2e-data-"));
  process.env.GENLIMITLESS_DATA_DIR = isolatedDataDir;
}

// Same idea for accounts.db + auth-secret.key (src/lib/accounts): a throwaway ACCOUNTS_DIR, never the real one.
{
  const inherited = process.env.ACCOUNTS_DIR;
  process.env.ACCOUNTS_DIR =
    inherited && path.basename(inherited).startsWith("glos-accounts-e2e-")
      ? inherited
      : fs.mkdtempSync(path.join(os.tmpdir(), "glos-accounts-e2e-"));
}
// The harness server is an explicit test server (relaxes refuseTestFixture); a data dir alone no longer means that.
process.env.GLOS_TEST_SERVER = "1";

// Internal token for the loopback auth bypass (src/lib/auth/policy.ts). Loaded after the data dir env is set.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const internalToken: string = process.env.E2E_INTERNAL_TOKEN || require("./src/lib/auth/policy").internalToken();

// The member-cell test server gets its OWN throwaway data dir (so rows other specs create as "Owner" can't leak into its pages).
// It gets a copy of the owner dir's per-cell internal secret so the one internal-token header works for both servers.
const memberDataDir: string = (() => {
  const inherited = process.env.E2E_MEMBER_DATA_DIR;
  if (inherited && path.basename(inherited).startsWith("genlimitless-e2e-data-")) return inherited;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "genlimitless-e2e-data-member-"));
  try { fs.copyFileSync(path.join(isolatedDataDir!, "internal-secret.key"), path.join(d, "internal-secret.key"), fs.constants.COPYFILE_EXCL); } catch {}
  process.env.E2E_MEMBER_DATA_DIR = d;
  return d;
})();

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 1,
  // Each worker launches its own headless Chromium; on this shared server the default (~half the CPU cores) caused "browser closed" launch failures (46/197). Cap it; override with E2E_WORKERS if the machine has headroom.
  workers: Number(process.env.E2E_WORKERS) || 2,
  reporter: [["list"], ["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME || "data/e2e-last-run.json" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || (startServer ? `http://localhost:${OWNER_PORT}` : "http://localhost:3100"),
    headless: true,
    extraHTTPHeaders: { "x-glos-internal": internalToken },
  },
  webServer: startServer
    ? [
        {
          command: `npx next dev -p ${OWNER_PORT}`,
          url: `http://localhost:${OWNER_PORT}`,
          reuseExistingServer: true,
          timeout: 120_000,
          // Playwright does not merge webServer.env with process.env, so spread it explicitly
          // (Gmail creds, GOOGLE_CLIENT_ID, TZ, etc. — the isolated server still needs real creds to
          // talk to Gmail; only its data/ directory and scheduler are isolated).
          env: { ...process.env, DISABLE_SCHEDULER: "1", DISABLE_AUTO_ORGANIZE: "1", E2E_FIXTURES: "1", GENLIMITLESS_DATA_DIR: isolatedDataDir!, ACCOUNTS_DIR: process.env.ACCOUNTS_DIR!, GLOS_TEST_SERVER: "1" },
        },
        {
          // A member cell (docs/multi-user.md "Member mode") on its own throwaway data dir (same auth secret copied in, so the one
          // internal-token header works) and its own .next folder. Scheduler stays off: tests must never trigger an agent.
          command: `npx next dev -p ${MEMBER_PORT}`,
          url: `http://localhost:${MEMBER_PORT}`,
          reuseExistingServer: true,
          timeout: 120_000,
          env: { ...process.env, DISABLE_SCHEDULER: "1", DISABLE_AUTO_ORGANIZE: "1", E2E_FIXTURES: "1", GENLIMITLESS_DATA_DIR: memberDataDir, GLOS_USER: "partner", GLOS_ROLE: "member", GLOS_DISPLAY_NAME: "Partner", GLOS_DIST_DIR: ".next-member", OWNER_PORT: String(OWNER_PORT), GLOS_TEST_SERVER: "1" },
        },
      ]
    : undefined,
});
