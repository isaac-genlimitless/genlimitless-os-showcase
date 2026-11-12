import { test, expect } from "@playwright/test";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

// Admin user library (src/lib/accounts/admin.ts) + accounts migration. Uses accounts.db in the throwaway ACCOUNTS_DIR
// only, plus a scratch sqlite file in os.tmpdir(). Never sends anything, never triggers an agent.

const id = (p: string) => `${p}${crypto.randomBytes(3).toString("hex")}`;
const META = { ip: "i", userAgent: "u", method: "t" };

function cols(d: Database.Database, table: string): string[] {
  return (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
}
function countWhere(d: Database.Database, sql: string, ...args: (string | number)[]): number {
  return (d.prepare(sql).get(...args) as { n: number }).n;
}
function errOf(fn: () => unknown): string {
  try {
    fn();
    return "no_error";
  } catch (e) {
    return (e as Error).message;
  }
}

async function load() {
  const users = await import("../src/lib/accounts/users");
  const admin = await import("../src/lib/accounts/admin");
  const store = await import("../src/lib/auth/store");
  const accountsDb: Database.Database = (await import("../src/lib/accounts/db")).default;
  const migrate = await import("../src/lib/accounts/migrate");
  return { users, admin, store, accountsDb, migrate };
}
function auditCount(d: Database.Database, actor: string, action: string, target: string): number {
  return countWhere(d, `SELECT COUNT(*) AS n FROM admin_audit WHERE actor = ? AND action = ? AND target = ?`, actor, action, target);
}

test("listUsers returns only safe fields and no credential material", async () => {
  const { users, admin, store } = await load();
  const a = id("ada"), m = id("adm");
  users.createUser({ id: a, display_name: "Admin A", role: "owner" });
  users.createUser({ id: m, display_name: "Member M", email: `${m}@example.com` });
  store.setPassword(m, "a-very-long-password-1");
  store.completeEnrollment(m);
  const list = admin.listUsers(a);
  const row = list.find((u) => u.id === m);
  expect(row).toBeDefined();
  expect(Object.keys(row!).sort()).toEqual(["created_at", "display_name", "email", "id", "last_active", "phone", "removed_at", "role", "roleLabel", "status"]);
  expect(row!.roleLabel).toBe("Member");
  expect(list.find((u) => u.id === a)!.roleLabel).toBe("Admin");
  expect(JSON.stringify(list)).not.toMatch(/hash|token|totp|secret|password/i);
});

test("last_active ignores impersonation sessions", async () => {
  const { users, admin, store, accountsDb } = await load();
  const a = id("adb"), m = id("adn");
  users.createUser({ id: a, display_name: "Admin", role: "owner" });
  users.createUser({ id: m, display_name: "Member" });
  store.createSession(m, META);
  accountsDb.prepare(`UPDATE auth_sessions SET last_seen_at = 1000 WHERE user_id = ?`).run(m);
  accountsDb
    .prepare(`INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, last_seen_at, impersonator_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(m, crypto.randomBytes(8).toString("hex"), 1, Date.now() + 60000, 9_000_000_000_000, a);
  expect(admin.listUsers(a).find((u) => u.id === m)!.last_active).toBe(1000);
});

test("updateUser validates input and bumps updated_at", async () => {
  const { users, admin } = await load();
  const a = id("adc"), m = id("adp"), x = id("adq");
  users.createUser({ id: a, display_name: "Admin", role: "owner" });
  users.createUser({ id: m, display_name: "Member" });
  users.createUser({ id: x, display_name: "Other", email: `${x}@example.com` });
  expect(errOf(() => admin.updateUser(a, m, { display_name: "   " }))).toBe("bad_name");
  expect(errOf(() => admin.updateUser(a, m, { email: "nope" }))).toBe("bad_email");
  expect(errOf(() => admin.updateUser(a, m, { email: `${x}@EXAMPLE.com` }))).toBe("email_taken");
  expect(errOf(() => admin.updateUser(a, m, { phone: "abc" }))).toBe("bad_phone");
  expect(errOf(() => admin.updateUser(a, "nobody-here", { display_name: "Z" }))).toBe("not_found");
  const out = admin.updateUser(a, m, { display_name: "  New Name ", email: `${m}@Example.com`, phone: "+1 555 555 0100" });
  expect(out.display_name).toBe("New Name");
  expect(out.email).toBe(`${m}@example.com`);
  expect(out.phone).toBe("+1 555 555 0100");
  expect(users.getUser(m)!.updated_at ?? 0).toBeGreaterThan(0);
});

test("changeRole: no self change, no removed target, promote and demote", async () => {
  const { users, admin } = await load();
  const a = id("ade"), b = id("adf"), m = id("adg"), r = id("adh");
  users.createUser({ id: a, display_name: "A", role: "owner" });
  users.createUser({ id: b, display_name: "B", role: "owner" });
  users.createUser({ id: m, display_name: "M" });
  users.createUser({ id: r, display_name: "R" });
  expect(errOf(() => admin.changeRole(a, a, "member"))).toBe("self_change");
  expect(errOf(() => admin.changeRole(a, m, "boss" as unknown as "owner"))).toBe("bad_role");
  expect(admin.changeRole(a, m, "owner").roleLabel).toBe("Admin");
  expect(admin.changeRole(a, m, "member").roleLabel).toBe("Member");
  expect(admin.changeRole(a, b, "member").role).toBe("member"); // a is still an active admin
  admin.removeUser(a, r);
  expect(errOf(() => admin.changeRole(a, r, "owner"))).toBe("removed");
});

test("setStatus: deactivate revokes sessions, no self change, reactivate works", async () => {
  const { users, admin, store } = await load();
  const a = id("adi"), m = id("adj");
  users.createUser({ id: a, display_name: "A", role: "owner" });
  users.createUser({ id: m, display_name: "M" });
  const tok = store.createSession(m, META).token;
  expect(store.checkSession(tok).result).not.toBe("invalid");
  expect(errOf(() => admin.setStatus(a, a, "disabled"))).toBe("self_change");
  expect(errOf(() => admin.setStatus(a, m, "paused" as unknown as "active"))).toBe("bad_status");
  expect(admin.setStatus(a, m, "disabled").status).toBe("disabled");
  expect(store.checkSession(tok).result).toBe("invalid");
  expect(admin.setStatus(a, m, "active").status).toBe("active");
  const tok2 = store.createSession(m, META).token;
  expect(store.checkSession(tok2).result).not.toBe("invalid");
});

test("removeUser is soft and restorable", async () => {
  const { users, admin, store } = await load();
  const a = id("adk"), b = id("adl"), m = id("adm"), n = id("adn");
  users.createUser({ id: a, display_name: "A", role: "owner" });
  users.createUser({ id: b, display_name: "B", role: "owner" });
  users.createUser({ id: m, display_name: "M" });
  users.createUser({ id: n, display_name: "N" });
  const tok = store.createSession(m, META).token;
  const out = admin.removeUser(a, m);
  expect(out.status).toBe("disabled");
  expect(out.removed_at).toBeGreaterThan(0);
  expect(users.getUser(m)).toBeDefined(); // the row is still there
  expect(store.checkSession(tok).result).toBe("invalid");
  expect(admin.listUsers(a).some((u) => u.id === m)).toBe(false);
  expect(admin.listUsers(a, { includeRemoved: true }).some((u) => u.id === m)).toBe(true);
  expect(errOf(() => admin.setStatus(a, m, "active"))).toBe("removed");
  expect(errOf(() => admin.updateUser(a, m, { display_name: "Z" }))).toBe("removed");
  expect(errOf(() => admin.removeUser(a, b))).toBe("cannot_remove_admin");
  expect(errOf(() => admin.removeUser(a, a))).toBe("self_change");
  expect(errOf(() => admin.restoreUser(a, n))).toBe("not_removed");
  const back = admin.restoreUser(a, m);
  expect(back.removed_at).toBeNull();
  expect(back.status).toBe("active");
  expect(admin.listUsers(a).some((u) => u.id === m)).toBe(true);
});

test("every admin function refuses a member, a disabled admin and an unknown actor", async () => {
  const { users, admin } = await load();
  const a = id("adr"), d = id("ads"), m = id("adt"), t = id("adu");
  users.createUser({ id: a, display_name: "A", role: "owner" });
  users.createUser({ id: d, display_name: "D", role: "owner" });
  users.createUser({ id: m, display_name: "M" });
  users.createUser({ id: t, display_name: "T" });
  admin.setStatus(a, d, "disabled");
  for (const actor of [m, d, id("ghost")]) {
    expect(errOf(() => admin.listUsers(actor))).toBe("forbidden");
    expect(errOf(() => admin.updateUser(actor, t, { display_name: "X" }))).toBe("forbidden");
    expect(errOf(() => admin.changeRole(actor, t, "owner"))).toBe("forbidden");
    expect(errOf(() => admin.setStatus(actor, t, "disabled"))).toBe("forbidden");
    expect(errOf(() => admin.removeUser(actor, t))).toBe("forbidden");
    expect(errOf(() => admin.restoreUser(actor, t))).toBe("forbidden");
    expect(errOf(() => admin.listAudit(actor))).toBe("forbidden");
  }
  expect(admin.listUsers(a).find((u) => u.id === t)!.role).toBe("member"); // nothing leaked through
});

test("each mutation writes exactly one audit row", async () => {
  const { users, admin, accountsDb } = await load();
  const a = id("adv"), m = id("adw");
  users.createUser({ id: a, display_name: "A", role: "owner" });
  users.createUser({ id: m, display_name: "M" });
  admin.updateUser(a, m, { display_name: "M2" });
  admin.changeRole(a, m, "owner");
  admin.changeRole(a, m, "member");
  admin.setStatus(a, m, "disabled");
  admin.setStatus(a, m, "active");
  admin.removeUser(a, m);
  admin.restoreUser(a, m);
  expect(auditCount(accountsDb, a, "user.update", m)).toBe(1);
  expect(auditCount(accountsDb, a, "user.role", m)).toBe(2);
  expect(auditCount(accountsDb, a, "user.deactivate", m)).toBe(1);
  expect(auditCount(accountsDb, a, "user.reactivate", m)).toBe(1);
  expect(auditCount(accountsDb, a, "user.remove", m)).toBe(1);
  expect(auditCount(accountsDb, a, "user.restore", m)).toBe(1);
  expect(admin.listAudit(a, 5).length).toBe(5);
});

test("migrateAccounts is idempotent and keeps users and live sessions", async () => {
  const { users, store, accountsDb, migrate } = await load();
  const { accountsDir, ACCOUNTS_DB_FILE } = await import("../src/lib/accounts/dir");
  const u = id("adx");
  users.createUser({ id: u, display_name: "U" });
  const tok = store.createSession(u, META).token;
  const file = path.join(accountsDir(), ACCOUNTS_DB_FILE);
  migrate.migrateAccounts(accountsDb, file);
  migrate.migrateAccounts(accountsDb, file);
  expect(users.getUser(u)).toBeDefined();
  expect(store.checkSession(tok).result).not.toBe("invalid");
  for (const c of ["removed_at", "updated_at"]) expect(cols(accountsDb, "users")).toContain(c);
  for (const c of ["impersonator_id", "read_only"]) expect(cols(accountsDb, "auth_sessions")).toContain(c);
  expect(cols(accountsDb, "admin_audit")).toEqual(["id", "at", "actor", "action", "target", "detail", "ip"]);
});

test("migrateAccounts upgrades an old-schema file in place and takes a backup copy first", async () => {
  const { migrate } = await load();
  const { ACCOUNTS_SCHEMA } = await import("../src/lib/accounts/schema.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glos-mig-"));
  const file = path.join(dir, "old.db");
  const d = new Database(file);
  try {
    d.pragma("journal_mode = WAL");
    d.exec(ACCOUNTS_SCHEMA);
    d.prepare(`INSERT INTO users (id, display_name, role, status, created_at) VALUES ('olduser', 'Old', 'member', 'active', 1)`).run();
    expect(cols(d, "users")).not.toContain("removed_at");
    migrate.migrateAccounts(d, file);
    expect(cols(d, "users")).toEqual(expect.arrayContaining(["removed_at", "updated_at"]));
    expect(cols(d, "auth_sessions")).toEqual(expect.arrayContaining(["impersonator_id", "read_only"]));
    expect(countWhere(d, `SELECT COUNT(*) AS n FROM users WHERE id = ?`, "olduser")).toBe(1);
    expect(fs.readdirSync(dir).some((f) => f.startsWith("old.db.pre-users-"))).toBe(true);
    migrate.migrateAccounts(d, file); // second run: no error, no second backup needed
  } finally {
    d.close();
  }
});

test("admin.ts and migrate.ts never delete or drop anything", async () => {
  for (const f of ["src/lib/accounts/admin.ts", "src/lib/accounts/migrate.ts"]) {
    const src = fs.readFileSync(path.join(process.cwd(), f), "utf8");
    expect(src).not.toMatch(/\bDELETE\s+FROM\b|\bDROP\s/i);
  }
});
