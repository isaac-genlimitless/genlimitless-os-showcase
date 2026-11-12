import path from "path";
import Database from "better-sqlite3";

// The ONLY place an e2e spec/helper is allowed to open sqlite directly. Refuses outright
// unless it can prove it's pointed at the isolated test DB — never falls back to Owner's
// real data/genlimitless.db.
export function openTestDb(): Database.Database {
  const dir = process.env.GENLIMITLESS_DATA_DIR;
  if (!process.env.E2E_START_SERVER || !dir) {
    throw new Error(
      "openTestDb() called without an isolated GENLIMITLESS_DATA_DIR — refusing to touch " +
        "Owner's real database. Run via `npm run test:e2e:branch`, never `npx playwright test` directly."
    );
  }
  return new Database(path.join(path.resolve(dir), "genlimitless.db"));
}

/** Where the isolated server keeps uploaded file bytes (same refusal rule as openTestDb). */
export function testFilesDir(): string {
  const dir = process.env.GENLIMITLESS_DATA_DIR;
  if (!process.env.E2E_START_SERVER || !dir) throw new Error("testFilesDir() called without an isolated GENLIMITLESS_DATA_DIR");
  return path.join(path.resolve(dir), "files");
}

/** Where the isolated server keeps meeting audio (same refusal rule as testFilesDir). */
export function testMeetingsDir(): string {
  const dir = process.env.GENLIMITLESS_DATA_DIR;
  if (!process.env.E2E_START_SERVER || !dir) throw new Error("testMeetingsDir() called without an isolated GENLIMITLESS_DATA_DIR");
  return path.join(path.resolve(dir), "meetings");
}
