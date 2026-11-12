import { test, expect } from "@playwright/test";

// Node-only unit test for openTestDb() itself — never touches the app, never presses Send,
// never triggers the agent. Proves the guard that stops e2e specs from ever falling back to
// Owner's real data/genlimitless.db.
test("openTestDb refuses to run without an isolated data dir", async () => {
  const prevServer = process.env.E2E_START_SERVER;
  const prevDir = process.env.GENLIMITLESS_DATA_DIR;
  delete process.env.E2E_START_SERVER;
  delete process.env.GENLIMITLESS_DATA_DIR;
  try {
    const { openTestDb } = await import("./db-handle");
    expect(() => openTestDb()).toThrow(/isolated/);
  } finally {
    if (prevServer) process.env.E2E_START_SERVER = prevServer;
    if (prevDir) process.env.GENLIMITLESS_DATA_DIR = prevDir;
  }
});
