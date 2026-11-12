import fs from "fs";
import path from "path";

// Every file that reads/writes under data/ (db.ts, attachments.ts, gdrive.ts, msg-index.ts,
// voice.ts, selftest.ts) goes through this, so a test run can redirect all of it to an
// isolated copy via GENLIMITLESS_DATA_DIR instead of writing into Owner's real data.
// On the server each deploy is a new release folder, so cwd/data would point inside a release that
// gets swapped out. If the shared live database already exists, use that folder instead.
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (env.GENLIMITLESS_DATA_DIR) return path.resolve(env.GENLIMITLESS_DATA_DIR);
  const shared = path.join(env.GLOS_ROOT || "/opt/genlimitless-os", "shared", "data");
  try {
    if (fs.existsSync(path.join(shared, "genlimitless.db"))) return shared;
  } catch {}
  return path.join(cwd, "data");
}

export const DATA_DIR = resolveDataDir();

/** Test fixtures are always named "E2E ...". On Owner's real data they're pollution (hundreds of fake
 *  rows piled up before isolation landed), so the create endpoints refuse them there. */
export function refuseTestFixture(name: unknown): string | null {
  if (process.env.GLOS_TEST_SERVER === "1") return null; // explicit test server (e2e harness, deploy probe): anything goes. A data dir alone no longer counts: member cells set one too.
  return typeof name === "string" && /^E2E /.test(name.trim())
    ? `"E2E ..." records are test fixtures and can't be created on the live data. Run writing specs with npm run test:e2e:branch.`
    : null;
}
