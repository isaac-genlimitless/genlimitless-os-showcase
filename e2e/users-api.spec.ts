import { test, expect } from "./isolated-test";
import { request } from "@playwright/test";
import type Database from "better-sqlite3";
import crypto from "node:crypto";
import { createUser } from "../src/lib/accounts/users";
import { createSession, sessionUserId } from "../src/lib/auth/store";
import accountsDbImport from "../src/lib/accounts/db";
import { sha256Hex } from "../src/lib/auth/crypto";
import { internalTokenFor } from "../src/lib/auth/policy";

// Admin-only Users API (part 2/6). HTTP against the isolated owner server; the runner shares its throwaway
// ACCOUNTS_DIR (same technique as member-mode.spec.ts). Never presses Send, never triggers an agent.
const accountsDb: Database.Database = accountsDbImport as unknown as Database.Database;
test.setTimeout(120_000);

const rid = () => crypto.randomBytes(4).toString("hex");
const ck = (t: string) => ({ cookie: `glos_session=${t}` });
const sess = (id: string) => createSession(id, { ip: "127.0.0.1", userAgent: "e2e users-api", method: "test" }).token;
function mk(role: "owner" | "member", prefix: string) {
  const id = `${prefix}${rid()}`;
  createUser({ id, display_name: `User ${id}`, role });
  return { id, token: sess(id) };
}

test("no or bogus cookie -> 401", async ({ request: api }) => {
  for (const headers of [{}, ck("bogus-token")]) {
    expect((await api.get("/api/users", { headers })).status()).toBe(401);
    expect((await api.get("/api/users?audit=1", { headers })).status()).toBe(401);
    expect((await api.patch("/api/users/x", { headers, data: { display_name: "A" } })).status()).toBe(401);
    expect((await api.post("/api/users/x", { headers, data: { action: "deactivate" } })).status()).toBe(401);
  }
});

test("member session -> 403 admin_only", async ({ request: api }) => {
  const m = mk("member", "mem");
  const headers = ck(m.token);
  for (const r of [
    await api.get("/api/users", { headers }),
    await api.get("/api/users?audit=1", { headers }),
    await api.patch("/api/users/x", { headers, data: { display_name: "A" } }),
    await api.post("/api/users/x", { headers, data: { action: "deactivate" } }),
  ]) {
    expect(r.status()).toBe(403);
    expect((await r.json()).error).toBe("admin_only");
  }
});

test("admin full cycle, refusals, audit, safe shape", async ({ request: api }) => {
  const admin = mk("owner", "adm");
  const b = mk("owner", "adb");
  const m = mk("member", "tgt");
  const h = ck(admin.token);
  const url = `/api/users/${m.id}`;

  const list = await api.get("/api/users", { headers: h });
  expect(list.status()).toBe(200);
  const listText = await list.text();
  expect(listText).toContain(m.id);
  expect(listText).not.toMatch(/hash|token|totp|secret|password/i);

  const up = await api.patch(url, { headers: h, data: { display_name: "Renamed", email: `${m.id}@example.com`, phone: "+15555550123" } });
  expect(up.status()).toBe(200);
  expect((await up.json()).user.display_name).toBe("Renamed");
  expect((await up.json()).user.email).toBe(`${m.id}@example.com`);

  const badEmail = await api.patch(url, { headers: h, data: { email: "not-an-email" } });
  expect(badEmail.status()).toBe(400);
  expect((await badEmail.json()).error).toBe("bad_email");

  expect((await api.patch(url, { headers: h, data: { role: "owner" } })).status()).toBe(200);
  expect((await api.patch(url, { headers: h, data: { role: "member" } })).status()).toBe(200);
  const both = await api.patch(url, { headers: h, data: { role: "owner", display_name: "X" } });
  expect(both.status()).toBe(400);
  expect((await both.json()).error).toBe("role_must_be_alone");
  const empty = await api.patch(url, { headers: h, data: {} });
  expect(empty.status()).toBe(400);
  expect((await empty.json()).error).toBe("nothing_to_update");

  const off = await api.post(url, { headers: h, data: { action: "deactivate" } });
  expect(off.status()).toBe(200);
  expect((await off.json()).user.status).toBe("disabled");
  expect(sessionUserId(m.token)).toBeNull();
  const on = await api.post(url, { headers: h, data: { action: "reactivate" } });
  expect((await on.json()).user.status).toBe("active");

  const rm = await api.post(url, { headers: h, data: { action: "remove" } });
  expect(rm.status()).toBe(200);
  expect((await rm.json()).user.removed_at).toBeTruthy();
  expect((await (await api.get("/api/users", { headers: h })).text())).not.toContain(m.id);
  expect((await (await api.get("/api/users?removed=1", { headers: h })).text())).toContain(m.id);
  const cnt = accountsDb.prepare(`SELECT COUNT(*) AS n FROM users WHERE id = ?`).get(m.id) as { n: number };
  expect(cnt.n).toBe(1);
  const rs = await api.post(url, { headers: h, data: { action: "restore" } });
  expect(rs.status()).toBe(200);
  const ru = (await rs.json()).user;
  expect(ru.removed_at ?? null).toBeNull();
  expect(ru.status).toBe("active");

  expect((await api.post("/api/users/nope" + rid(), { headers: h, data: { action: "deactivate" } })).status()).toBe(404);
  expect((await api.post(url, { headers: h, data: { action: "explode" } })).status()).toBe(400);
  expect((await api.post(url, { headers: { ...h, "content-type": "text/plain" }, data: "not json" })).status()).toBe(400);

  // refusals
  const self = await api.post(`/api/users/${admin.id}`, { headers: h, data: { action: "deactivate" } });
  expect(self.status()).toBe(409);
  expect((await self.json()).error).toBe("self_change");
  const rmAdmin = await api.post(`/api/users/${b.id}`, { headers: h, data: { action: "remove" } });
  expect(rmAdmin.status()).toBe(409);
  expect((await rmAdmin.json()).error).toBe("cannot_remove_admin");

  // audit
  const au = await api.get(`/api/users?audit=1&limit=500`, { headers: h });
  expect(au.status()).toBe(200);
  const auText = await au.text();
  expect(auText).not.toMatch(/hash|token|totp|secret|password/i);
  const rows = (JSON.parse(auText).audit as { actor: string; action: string; target: string | null }[]).filter((r) => r.target === m.id);
  for (const a of ["user.update", "user.role", "user.deactivate", "user.reactivate", "user.remove", "user.restore"]) {
    expect(rows.some((r) => r.action === a && r.actor === admin.id)).toBe(true);
  }
});

test("view-as session is read-only -> 403", async ({ request: api }) => {
  const admin = mk("owner", "adm");
  const other = mk("owner", "oth");
  const m = mk("member", "tgt");
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  accountsDb
    .prepare(`INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent, method, impersonator_id, read_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(other.id, sha256Hex(token), now, now + 600_000, now, "127.0.0.1", "e2e", "test", admin.id);
  const h = ck(token);
  const g = await api.get("/api/users", { headers: h });
  expect(g.status()).toBe(403);
  expect((await g.json()).error).toBe("impersonation_read_only");
  const p = await api.post(`/api/users/${m.id}`, { headers: h, data: { action: "deactivate" } });
  expect(p.status()).toBe(403);
  expect((await p.json()).error).toBe("impersonation_read_only");
  const row = accountsDb.prepare(`SELECT status FROM users WHERE id = ?`).get(m.id) as { status: string };
  expect(row.status).toBe("active");
});

test("member cell 404s the Users API", async () => {
  if (!getPartner()) return;
  const ctx = await request.newContext({
    baseURL: `http://localhost:${process.env.E2E_MEMBER_PORT || 3210}`,
    extraHTTPHeaders: {
      "x-glos-internal": internalTokenFor("partner", process.env.E2E_MEMBER_DATA_DIR),
      cookie: `glos_session=${getPartner()}`,
    },
  });
  expect((await ctx.get("/api/users")).status()).toBe(404);
  expect((await ctx.post("/api/users/x", { data: { action: "deactivate" } })).status()).toBe(404);
  await ctx.dispose();
});

function getPartner(): string | null {
  const exists = accountsDb.prepare(`SELECT 1 AS x FROM users WHERE id = 'partner'`).get();
  if (!exists) createUser({ id: "partner", display_name: "Partner", role: "member" });
  return sess("partner");
}
