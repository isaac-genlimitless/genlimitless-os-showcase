import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { accountsDir, ACCOUNTS_DB_FILE } from "./dir";
import { ACCOUNTS_SCHEMA } from "./schema.cjs";
import { migrateAccounts } from "./migrate";

// accounts.db: users, credentials, sessions, login codes, shares. Shared by every cell (WAL, several processes).
//
// Opened on first use, not at import: `next build` imports every route module, and a build must never create or
// open the real accounts folder.
let inst: Database.Database | null = null;

function open(): Database.Database {
  if (inst) return inst;
  const dir = accountsDir();
  fs.mkdirSync(dir, { recursive: true });
  const d = new Database(path.join(dir, ACCOUNTS_DB_FILE));
  d.pragma("journal_mode = WAL");
  d.pragma("busy_timeout = 5000");
  d.exec(ACCOUNTS_SCHEMA);
  migrateAccounts(d, path.join(dir, ACCOUNTS_DB_FILE));
  inst = d;
  return d;
}

const accountsDb = new Proxy({} as Database.Database, {
  get(_t, prop) {
    const d = open();
    const v = (d as unknown as Record<string | symbol, unknown>)[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(d) : v;
  },
});

export default accountsDb;
