import { test, expect } from "@playwright/test";
import crypto from "crypto";

// Per-user credentials, challenges and login-code recipients. Uses accounts.db in the throwaway ACCOUNTS_DIR only.
// Never sends a code (no delivery function is called), never triggers the agent.

const id = (p: string) => `${p}${crypto.randomBytes(3).toString("hex")}`;

test("credentials, backup codes, TOTP and challenges are per user", async () => {
  const users = await import("../src/lib/accounts/users");
  const store = await import("../src/lib/auth/store");
  const a = id("pua"), b = id("pub");
  users.createUser({ id: a, display_name: "A", email: `${a}@example.com`, phone: "+15555550101" });
  users.createUser({ id: b, display_name: "B", email: `${b}@example.com` });

  store.setPassword(a, "a-very-long-password-1");
  store.setPassword(b, "b-very-long-password-2");
  expect(store.checkPassword(a, "a-very-long-password-1")).toBe(true);
  expect(store.checkPassword(a, "b-very-long-password-2")).toBe(false);
  expect(store.checkPassword(b, "a-very-long-password-1")).toBe(false);

  const codesA = store.completeEnrollment(a);
  expect(store.getAuthState(a).enrolled).toBe(true);
  expect(store.getAuthState(b).enrolled).toBe(false);
  expect(store.consumeBackupCode(b, codesA[0])).toBe(false); // A's backup code does not work for B
  expect(store.consumeBackupCode(a, codesA[0])).toBe(true);
  expect(store.consumeBackupCode(a, codesA[0])).toBe(false);
  expect(store.unusedBackupCodeCount(a)).toBe(9);
  expect(store.unusedBackupCodeCount(b)).toBe(0);

  const ch = store.createChallenge(a, "127.0.0.1");
  expect(store.challengeUser(ch)).toBe(a);
  store.completeChallenge(ch);
  expect(store.challengeUser(ch)).toBeNull();

  // sessions: revoking others only touches the same user
  const sa1 = store.createSession(a, { ip: "i", userAgent: "u", method: "t" }).token;
  const sa2 = store.createSession(a, { ip: "i", userAgent: "u", method: "t" }).token;
  const sb = store.createSession(b, { ip: "i", userAgent: "u", method: "t" }).token;
  expect(store.revokeOtherSessions(a, sa1)).toBeGreaterThanOrEqual(1);
  expect(store.sessionUserId(sa2)).toBeNull();
  expect(store.sessionUserId(sa1)).toBe(a);
  expect(store.sessionUserId(sb)).toBe(b);
  expect(store.listSessions(b).length).toBe(1);

  // sign-in name: slug or email, case-insensitive; unknown and disabled users are not found
  expect(users.findUserByLogin(a.toUpperCase())?.id).toBe(a);
  expect(users.findUserByLogin(`${b}@EXAMPLE.com`)?.id).toBe(b);
  expect(users.findUserByLogin("nobody-here")).toBeUndefined();
});

test("login codes go to that user's own phone or email, never Owner's", async () => {
  const users = await import("../src/lib/accounts/users");
  const { loginRecipient } = await import("../src/lib/auth/recipient");
  const prev = process.env.OWNER_IMESSAGE_HANDLE;
  process.env.OWNER_IMESSAGE_HANDLE = "+19998887777";
  try {
    const a = id("lca"), b = id("lcb"), c = id("lcc");
    const ua = users.createUser({ id: a, display_name: "A", phone: "+15555550111", email: "a@example.com" });
    const ub = users.createUser({ id: b, display_name: "B", email: "b@example.com" });
    const uc = users.createUser({ id: c, display_name: "C" });
    expect(loginRecipient(ua)).toEqual({ kind: "phone", to: "+15555550111" });
    expect(loginRecipient(ub)).toEqual({ kind: "email", to: "b@example.com" });
    expect(loginRecipient(uc)).toBeNull(); // no fallback to Owner's handle
    const owner = users.ensureDefaultOwner();
    if (!owner.phone) expect(loginRecipient(owner)).toEqual({ kind: "phone", to: "+19998887777" });
  } finally {
    if (prev === undefined) delete process.env.OWNER_IMESSAGE_HANDLE;
    else process.env.OWNER_IMESSAGE_HANDLE = prev;
  }
});

test.describe("login page and API (harness server)", () => {
  test.skip(!process.env.E2E_START_SERVER, "assumes a fresh isolated server — only runs under `npm run test:e2e:branch`");

  test("login page has a username-or-email field", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("login-username")).toBeVisible();
    await expect(page.getByText("Username or email", { exact: true })).toBeVisible();
  });

  test("a named user that does not exist gets the same 401 as a wrong password", async ({ request }) => {
    const res = await request.post("/api/auth/login", { data: { username: "no-such-user", password: "wrong-password-123" } });
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid" });
  });
});
