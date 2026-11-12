import fs from "fs";
import path from "path";
import { assertOwnsAccounts } from "./identity";
import { resolveDataDir } from "../data-dir";

// Where accounts.db and auth-secret.key live. No imports of the database here, so crypto.ts can use it
// without opening anything.
//
// Production: /opt/genlimitless-os/shared/accounts (one folder every cell reads); a local clone uses <data dir>/accounts. Tests always pass ACCOUNTS_DIR
// (a temp dir): a test process with no ACCOUNTS_DIR is refused so it can never open the real accounts.db.
export function resolveAccountsDir(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
  cwd: string = process.cwd(),
): string {
  if (env.ACCOUNTS_DIR) return path.resolve(env.ACCOUNTS_DIR);
  const testing = env.TEST_WORKER_INDEX !== undefined || !!env.E2E_START_SERVER || env.GLOS_TEST_SERVER === "1";
  if (testing) {
    throw new Error("Refusing to use the real accounts folder from a test process: set ACCOUNTS_DIR to a temp dir.");
  }
  // Not on the server (no GLOS_ROOT, no /opt/genlimitless-os/shared): a local clone keeps accounts beside its data.
  // Without this a fresh checkout 500s on every request trying to mkdir under /opt.
  if (!env.GLOS_ROOT && !exists("/opt/genlimitless-os/shared")) return path.join(resolveDataDir(env, cwd), "accounts");
  return path.join(env.GLOS_ROOT || "/opt/genlimitless-os", "shared", "accounts");
}

let cached: string | null = null;
export function accountsDir(): string {
  assertOwnsAccounts("The accounts folder");
  if (!cached) cached = resolveAccountsDir();
  return cached;
}

export const AUTH_SECRET_FILE = "auth-secret.key";
export const ACCOUNTS_DB_FILE = "accounts.db";
