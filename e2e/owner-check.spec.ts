import { test, expect } from "@playwright/test";
import { askOwner, clearOwnerCheckCache, ownerPort, OWNER_CHECK_TTL_MS } from "../src/lib/auth/owner-check";

// Member cells ask the owner who a cookie belongs to. Pure logic with a fake fetch: no network, sends nothing.
const reply = (status: number, user?: string, slid = false) =>
  (async () => new Response(null, { status, headers: { ...(user ? { "x-glos-user": user } : {}), ...(slid ? { "x-glos-slid": "1" } : {}) } })) as unknown as typeof fetch;

test("only a 204 naming this cell's user counts", async () => {
  clearOwnerCheckCache();
  expect((await askOwner("t1", "partner", { fetchImpl: reply(204, "partner") })).ok).toBe(true);
  expect((await askOwner("t2", "partner", { fetchImpl: reply(204, "owner") })).ok).toBe(false); // someone else's session
  expect((await askOwner("t3", "partner", { fetchImpl: reply(204) })).ok).toBe(false); // no user header
  expect((await askOwner("t4", "partner", { fetchImpl: reply(401, "partner") })).ok).toBe(false);
  expect((await askOwner("t5", "partner", { fetchImpl: reply(200, "partner") })).ok).toBe(false);
  expect((await askOwner("t6", "partner", { fetchImpl: reply(204, "partner", true) })).slid).toBe(true);
});

test("owner down or slow fails closed; successes are cached 30s, failures never become successes", async () => {
  clearOwnerCheckCache();
  const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  expect((await askOwner("d1", "partner", { fetchImpl: down })).ok).toBe(false);

  let calls = 0;
  const counting = (async () => { calls++; return new Response(null, { status: 204, headers: { "x-glos-user": "partner" } }); }) as unknown as typeof fetch;
  const t0 = 1_000_000;
  expect((await askOwner("c1", "partner", { fetchImpl: counting, now: t0 })).ok).toBe(true);
  expect((await askOwner("c1", "partner", { fetchImpl: counting, now: t0 + OWNER_CHECK_TTL_MS - 1 })).ok).toBe(true);
  expect(calls).toBe(1);
  expect((await askOwner("c1", "partner", { fetchImpl: counting, now: t0 + OWNER_CHECK_TTL_MS + 1 })).ok).toBe(true);
  expect(calls).toBe(2);
  // after expiry, a now-revoked session is refused straight away
  const revoked = reply(401);
  expect((await askOwner("c1", "partner", { fetchImpl: revoked, now: t0 + 2 * OWNER_CHECK_TTL_MS + 5 })).ok).toBe(false);
  // the cache is keyed by user + token: the same token under another user is not a hit
  expect((await askOwner("c1", "owner", { fetchImpl: revoked, now: t0 + 2 * OWNER_CHECK_TTL_MS + 6 })).ok).toBe(false);
});

test("OWNER_PORT defaults to 3100 and ignores junk", () => {
  expect(ownerPort({} as unknown as NodeJS.ProcessEnv)).toBe(3100);
  expect(ownerPort({ OWNER_PORT: "3555" } as unknown as NodeJS.ProcessEnv)).toBe(3555);
  expect(ownerPort({ OWNER_PORT: "abc" } as unknown as NodeJS.ProcessEnv)).toBe(3100);
  expect(ownerPort({ OWNER_PORT: "99999" } as unknown as NodeJS.ProcessEnv)).toBe(3100);
});
