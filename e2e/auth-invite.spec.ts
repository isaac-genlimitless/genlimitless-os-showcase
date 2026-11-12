import { test, expect } from "@playwright/test";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// One-time setup links. Uses accounts.db in the throwaway ACCOUNTS_DIR only. Never sends a code (the full flow
// plants a login code with the library instead of calling send_code), never triggers the agent.
// Failed token lookups count toward the sign-in rate limit, so the API tests keep failing calls to a minimum.

const id = (p: string) => `${p}${crypto.randomBytes(3).toString("hex")}`;
const DAY = 24 * 60 * 60 * 1000;
async function getDb() {
  const m = (await import("../src/lib/accounts/db")) as unknown as { default: import("better-sqlite3").Database & { default?: import("better-sqlite3").Database } };
  return (m.default.default || m.default) as import("better-sqlite3").Database;
}

test("a link works once, for its own member, within 72 hours", async () => {
  const users = await import("../src/lib/accounts/users");
  const inv = await import("../src/lib/auth/invites");
  const a = id("ina"), b = id("inb");
  users.createUser({ id: a, display_name: "A", email: `${a}@example.com` });
  users.createUser({ id: b, display_name: "B", email: `${b}@example.com` });

  const now = Date.now();
  const ta = inv.createInvite(a, now);
  expect(ta.expiresAt - now).toBe(72 * 60 * 60 * 1000);
  expect(inv.inviteUser(ta.token, now)?.id).toBe(a); // names A, never B
  expect(inv.inviteUser(ta.token, now + 71 * 60 * 60 * 1000)?.id).toBe(a);
  expect(inv.inviteUser(ta.token, now + 73 * 60 * 60 * 1000)).toBeNull(); // expired
  expect(inv.inviteUser("x".repeat(43))).toBeNull(); // unknown
  expect(inv.inviteUser("short")).toBeNull();

  const tb = inv.createInvite(b, now);
  expect(inv.inviteUser(tb.token, now)?.id).toBe(b);
  expect(inv.inviteUser(ta.token, now)?.id).toBe(a); // B's link did not replace A's

  expect(inv.consumeInvite(ta.token, now)).toBe(true);
  expect(inv.consumeInvite(ta.token, now)).toBe(false); // used
  expect(inv.inviteUser(ta.token, now)).toBeNull();

  // a newer link replaces older unused ones
  const t1 = inv.createInvite(b, now).token;
  const t2 = inv.createInvite(b, now).token;
  expect(inv.inviteUser(t1, now)).toBeNull();
  expect(inv.inviteUser(t2, now)?.id).toBe(b);
  void DAY;
});

test("a link never works for the owner, an enrolled member, or a disabled one", async () => {
  const users = await import("../src/lib/accounts/users");
  const inv = await import("../src/lib/auth/invites");
  const store = await import("../src/lib/auth/store");
  const db = await getDb();
  const { sha256Hex, newToken } = await import("../src/lib/auth/crypto");

  users.ensureDefaultOwner();
  expect(() => inv.createInvite("owner")).toThrow(/owner/);
  // Even a hand-planted row for the owner is refused.
  const planted = newToken();
  db.prepare(`INSERT INTO auth_invites (user_id, token_hash, created_at, expires_at) VALUES ('owner', ?, ?, ?)`).run(sha256Hex(planted), Date.now(), Date.now() + 1e6);
  expect(inv.inviteUser(planted)).toBeNull();

  const e = id("ine");
  users.createUser({ id: e, display_name: "E", email: `${e}@example.com` });
  const t = inv.createInvite(e).token;
  store.setPassword(e, "a-very-long-password-1");
  store.completeEnrollment(e);
  expect(inv.inviteUser(t)).toBeNull(); // already enrolled
  expect(() => inv.createInvite(e)).toThrow(/enrolled/);

  const d = id("ind");
  users.createUser({ id: d, display_name: "D", email: `${d}@example.com` });
  const td = inv.createInvite(d).token;
  db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(d);
  expect(inv.inviteUser(td)).toBeNull();
  expect(() => inv.createInvite("nobody-here")).toThrow();
});

test("the setup page and API: password, code, then a real session for that member only", async ({ request }) => {
  const users = await import("../src/lib/accounts/users");
  const inv = await import("../src/lib/auth/invites");
  const store = await import("../src/lib/auth/store");
  const db = await getDb();
  // The server's secret, read from the file itself: a Playwright worker may have cached a previous spec's ACCOUNTS_DIR in
  // the library module, but this server uses the file in the harness's ACCOUNTS_DIR.
  const secretFile = path.join(process.env.ACCOUNTS_DIR!, "auth-secret.key");
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  try { fs.writeFileSync(secretFile, crypto.randomBytes(32).toString("hex"), { mode: 0o640, flag: "wx" }); } catch { /* exists */ }
  const secret = fs.readFileSync(secretFile, "utf8").trim();
  const hashCode = (c: string, ch: string) => crypto.createHmac("sha256", secret).update(`${ch}:${c}`).digest("hex");
  const m = id("inm");
  users.createUser({ id: m, display_name: "Mina", email: `${m}@example.com` });
  const { token } = inv.createInvite(m);

  const page = await request.get(`/setup/${token}`);
  expect(page.status()).toBe(200);

  const post = (body: Record<string, unknown>, cookie?: string) =>
    request.post("/api/auth/invite", { data: { token, ...body }, headers: cookie ? { cookie } : {} });

  const chk = await post({ action: "check" });
  expect(chk.status()).toBe(200);
  expect((await chk.json()).name).toBe("Mina");
  expect((await post({ action: "password", password: "short" })).status()).toBe(400);
  expect((await post({ action: "password", password: "a-very-long-password-1" })).status()).toBe(200);
  expect(store.checkPassword(m, "a-very-long-password-1")).toBe(true);

  // No challenge yet: cannot complete.
  expect((await post({ action: "complete", code: "123456" })).status()).toBe(401);

  // Plant a challenge and its code (instead of sending one).
  const ch = store.createChallenge(m, "local");
  db.prepare(`INSERT INTO login_codes (user_id, challenge_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(m, ch, hashCode("424242", ch), Date.now() + 60_000, Date.now());
  const wrong = await post({ action: "complete", code: "000000" }, `glos_challenge=${ch}`);
  expect(wrong.status(), await wrong.text()).toBe(401);
  const ok = await post({ action: "complete", code: "424242" }, `glos_challenge=${ch}`);
  expect(ok.status(), await ok.text()).toBe(200);
  expect((await ok.json()).backupCodes.length).toBe(10);
  const setCookie = ok.headers()["set-cookie"] || "";
  const session = /glos_session=([^;]+)/.exec(setCookie)?.[1] || "";
  expect(session).not.toBe("");
  expect(store.sessionUserId(session)).toBe(m);
  const who = await request.get("/api/auth/check", { headers: { cookie: `glos_session=${session}` } });
  expect(who.status()).toBe(204);
  expect(who.headers()["x-glos-user"]).toBe(m);

  // The link is spent.
  expect((await post({ action: "check" })).status()).toBe(404);
});

test("policy: only /setup/<43-char token> and /api/auth/invite are public", async () => {
  const { decide } = await import("../src/lib/auth/policy");
  const headers = { host: "os.example.com", "x-forwarded-for": "203.0.113.9" };
  const base = { method: "GET", headers, enrolled: true, enforce: true, breakGlass: false, sessionValid: false };
  expect(decide({ ...base, path: `/setup/${"a".repeat(43)}` })).toBe("allow");
  expect(decide({ ...base, path: "/setup/short" })).toBe("login_redirect");
  expect(decide({ ...base, path: "/setup/" })).toBe("login_redirect");
  expect(decide({ ...base, path: `/setup/${"a".repeat(43)}/x` })).toBe("login_redirect");
  expect(decide({ ...base, path: "/api/auth/invite", method: "POST" })).toBe("allow");
});
