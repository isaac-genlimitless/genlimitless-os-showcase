import { test, expect } from "@playwright/test";
import crypto from "crypto";

const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

// playwright.config.ts gives the runner and every worker a throwaway ACCOUNTS_DIR; rows here use their own user ids.
// Sends nothing, triggers no agent.
test("session expiry slides 30 days from last use", async () => {
  const store = await import("../src/lib/auth/store");
  const users = await import("../src/lib/accounts/users");
  const dbMod = (await import("../src/lib/accounts/db")) as unknown as { default: import("better-sqlite3").Database & { default?: import("better-sqlite3").Database } };
  const db = (dbMod.default.default || dbMod.default) as import("better-sqlite3").Database;
  users.createUser({ id: "owner", display_name: "Owner", role: "owner" });
  users.createUser({ id: "slide-partner", display_name: "Partner" });
  const DAY = 24 * 60 * 60 * 1000;
  const meta = { ip: "127.0.0.1", userAgent: "test", method: "test" };

  const { token } = store.createSession("owner", meta);
  expect(store.checkSession(token)).toEqual({ result: "valid", userId: "owner" });

  const now = Date.now();
  db.prepare(`UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?`).run(now - 10 * 60 * 1000, now + DAY, sha(token));
  expect(store.checkSession(token).result).toBe("slid");
  const r = db.prepare(`SELECT expires_at FROM auth_sessions WHERE token_hash = ?`).get(sha(token)) as { expires_at: number };
  expect(Math.abs(r.expires_at - (Date.now() + 30 * DAY))).toBeLessThan(60 * 1000);
  expect(store.validateSession(token)).toBe(true);

  // A session belongs to exactly one user; this cell is owner's.
  const k = store.createSession("slide-partner", meta).token;
  expect(store.sessionUserId(k)).toBe("slide-partner");
  expect(store.validateSession(k)).toBe(false);

  store.revokeSession(token);
  expect(store.checkSession(token).result).toBe("invalid");

  const exp = store.createSession("owner", meta).token;
  db.prepare(`UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?`).run(Date.now() - 1000, sha(exp));
  expect(store.checkSession(exp).result).toBe("invalid");
  expect(store.checkSession("unknown-token").result).toBe("invalid");
  expect(store.checkSession(undefined).result).toBe("invalid");

  // A disabled user's session stops working.
  db.prepare(`UPDATE users SET status='disabled' WHERE id='slide-partner'`).run();
  expect(store.checkSession(k).result).toBe("invalid");
});
