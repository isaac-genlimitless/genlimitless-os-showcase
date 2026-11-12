import { test, expect } from "@playwright/test";

// Uses the throwaway ACCOUNTS_DIR from playwright.config.ts. Sends nothing, triggers no agent.
// Needs part 1's schema (impersonator_id, read_only on auth_sessions; admin_audit).
type DB = import("better-sqlite3").Database;

async function setup() {
  const store = await import("../src/lib/auth/store");
  const imp = await import("../src/lib/auth/impersonation");
  const users = await import("../src/lib/accounts/users");
  const dbMod = (await import("../src/lib/accounts/db")) as unknown as { default: DB & { default?: DB } };
  const db = (dbMod.default.default || dbMod.default) as DB;
  return { store, imp, users, db };
}
const meta = { ip: "127.0.0.1", userAgent: "test" };
const smeta = { ...meta, method: "test" };

test("admin can start view-as on a member; refusals", async () => {
  const { store, imp, users, db } = await setup();
  users.createUser({ id: "owner", display_name: "Owner", role: "owner" });
  users.createUser({ id: "imp-m", display_name: "Member" });
  users.createUser({ id: "imp-m2", display_name: "Member Two" });
  users.createUser({ id: "imp-admin2", display_name: "Admin2", role: "owner" });
  users.createUser({ id: "imp-off", display_name: "Off" });
  db.prepare(`UPDATE users SET status = 'disabled' WHERE id = 'imp-off'`).run();

  const admin = store.createSession("owner", smeta).token;
  const memberTok = store.createSession("imp-m", smeta).token;

  expect(imp.startImpersonation(memberTok, "imp-m2", meta).ok).toBe(false);
  expect(imp.startImpersonation(undefined, "imp-m", meta).ok).toBe(false);
  for (const t of ["owner", "imp-admin2", "imp-off", "nobody"]) {
    expect(imp.startImpersonation(admin, t, meta).ok).toBe(false);
  }

  const r = imp.startImpersonation(admin, "imp-m", meta);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const c = store.checkSession(r.token);
  expect(c).toEqual({ result: "valid", userId: "imp-m", imp: { by: "owner", readOnly: true } });

  // no nesting
  expect(imp.startImpersonation(r.token, "imp-m2", meta).ok).toBe(false);

  // status has no secrets
  const st = imp.impersonationStatus(r.token);
  expect(st).toMatchObject({ active: true, as: "imp-m", by: "owner", read_only: true });
  const json = JSON.stringify(st);
  expect(json).not.toContain(r.token);
  expect(json).not.toMatch(/token|hash/i);
  expect(imp.impersonationStatus(admin)).toEqual({ active: false });

  // second start revokes the first
  const r2 = imp.startImpersonation(admin, "imp-m2", meta);
  expect(r2.ok).toBe(true);
  expect(store.checkSession(r.token).result).toBe("invalid");

  // stop revokes; admin session still live
  if (r2.ok) {
    expect(imp.stopImpersonation(r2.token)).toEqual({ by: "owner", as: "imp-m2" });
    expect(store.checkSession(r2.token).result).toBe("invalid");
  }
  expect(imp.isLiveAdminSession(admin, "owner")).toBe(true);
  expect(imp.isLiveAdminSession(memberTok, "owner")).toBe(false);
  expect(imp.isLiveAdminSession("tampered", "owner")).toBe(false);
  expect(imp.isLiveAdminSession(undefined, "owner")).toBe(false);

  const audit = db.prepare(`SELECT action, actor, target, at FROM admin_audit WHERE action LIKE 'impersonate_%'`).all() as { action: string; actor: string; target: string; at: number }[];
  expect(audit.some((a) => a.action === "impersonate_start" && a.actor === "owner" && a.target === "imp-m" && a.at > 0)).toBe(true);
  expect(audit.some((a) => a.action === "impersonate_stop" && a.target === "imp-m2")).toBe(true);
});

test("impersonation expires at the TTL, never slides, expiry logged once; logout kills it", async () => {
  const { store, imp, users, db } = await setup();
  users.createUser({ id: "owner", display_name: "Owner", role: "owner" });
  users.createUser({ id: "imp-ttl", display_name: "Ttl" });
  const admin = store.createSession("owner", smeta).token;
  const now = Date.now();
  const r = imp.startImpersonation(admin, "imp-ttl", meta, now);
  if (!r.ok) throw new Error("start failed");
  expect(r.expiresAt - now).toBe(imp.IMPERSONATION_TTL_MS);

  // 10 minutes in: still valid, and the expiry did not move
  expect(store.checkSession(r.token, now + 10 * 60 * 1000).result).toBe("valid");
  const row = db.prepare(`SELECT expires_at FROM auth_sessions WHERE token_hash = ?`);
  const sha = (await import("../src/lib/auth/crypto")).sha256Hex;
  expect((row.get(sha(r.token)) as { expires_at: number }).expires_at).toBe(r.expiresAt);

  const after = now + imp.IMPERSONATION_TTL_MS + 1000;
  expect(store.checkSession(r.token, after).result).toBe("invalid");
  imp.sweepExpired(after);
  imp.impersonationStatus(r.token, after + 1);
  imp.sweepExpired(after + 2);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'impersonate_expired' AND target = 'imp-ttl'`).get() as { n: number };
  expect(n.n).toBe(1);

  const r3 = imp.startImpersonation(admin, "imp-ttl", meta);
  if (!r3.ok) throw new Error("start failed");
  expect(store.checkSession(r3.token).result).toBe("valid");
  imp.stopImpersonation(r3.token);
  store.revokeSession(r3.token);
  expect(store.checkSession(r3.token).result).toBe("invalid");
});
