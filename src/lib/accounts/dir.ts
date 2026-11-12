import path from "path";
import { assertOwnsAccounts } from "./identity";

// Where accounts.db and auth-secret.key live. No imports of the database here, so crypto.ts can use it
// without opening anything.
//
// Production: /opt/genlimitless-os/shared/accounts (one folder every cell reads). Tests always pass ACCOUNTS_DIR
// (a temp dir): a test process with no ACCOUNTS_DIR is refused so it can never open the real accounts.db.
export function resolveAccountsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ACCOUNTS_DIR) return path.resolve(env.ACCOUNTS_DIR);
  const testing = env.TEST_WORKER_INDEX !== undefined || !!env.E2E_START_SERVER || env.GLOS_TEST_SERVER === "1";
  if (testing) {
    throw new Error("Refusing to use the real accounts folder from a test process: set ACCOUNTS_DIR to a temp dir.");
  }
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
