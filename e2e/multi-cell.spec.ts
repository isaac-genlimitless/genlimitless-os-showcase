import { test, expect } from "@playwright/test";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

// Isolated "cells" (docs/multi-user.md): production servers from this build, each with its OWN throwaway data folder
// and GLOS_USER. One OWNER cell holds the throwaway ACCOUNTS_DIR (the one playwright.config.ts made); the MEMBER
// cells get no usable accounts folder at all and ask the owner over loopback who a session belongs to.
// Needs `npm run build` first (it starts `next start`). Creates tasks, pages and side chats only: never presses
// Send, never triggers the agent, texts nothing (the scheduler is off in both cells).

const ROOT = path.join(__dirname, "..");
const HAS_BUILD = fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"));
test.skip(!HAS_BUILD, "needs a production build (npm run build) to start the two cells");
test.describe.configure({ mode: "serial" });

type Cell = { user: string; port: number; proc: ChildProcess; token: string; dataDir: string; log: string[] };

const NO_ACCOUNTS = path.join(os.tmpdir(), `glos-no-such-accounts-${process.pid}`, "accounts"); // never created; a member must not need it

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

async function waitUp(port: number, proc: ChildProcess, log: string[]) {
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    if (proc.exitCode !== null) throw new Error("cell exited early:\n" + log.join(""));
    try {
      // `next start` adds x-forwarded-* headers itself, so loopback health is 401 here; any answer means it is up.
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("cell did not start:\n" + log.join(""));
}

let O: Cell; // owner
let A: Cell;
let B: Cell;
let LONELY: Cell; // member whose owner is not running
const cells: Cell[] = [];
const sfx = Math.random().toString(36).slice(2, 8);

async function startCell(user: string, role: "owner" | "member", ownerPort: number): Promise<Cell> {
  const { createUser } = await import("../src/lib/accounts/users");
  const { createSession } = await import("../src/lib/auth/store");
  createUser({ id: user, display_name: user, role });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `genlimitless-e2e-data-cell-${user}-`));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    GLOS_USER: user,
    GLOS_ROLE: role,
    OWNER_PORT: String(ownerPort || port),
    GENLIMITLESS_DATA_DIR: dataDir,
    ACCOUNTS_DIR: role === "owner" ? process.env.ACCOUNTS_DIR : NO_ACCOUNTS,
    GLOS_TEST_SERVER: "1",
    DISABLE_SCHEDULER: "1",
    DISABLE_AUTO_ORGANIZE: "1",
  };
  const log: string[] = [];
  const proc = spawn(path.join(ROOT, "node_modules", ".bin", "next"), ["start", "-H", "127.0.0.1", "-p", String(port)], { cwd: ROOT, env });
  proc.stdout?.on("data", (d) => log.push(String(d)));
  proc.stderr?.on("data", (d) => log.push(String(d)));
  const cell: Cell = {
    user, port, proc, log, dataDir,
    token: createSession(user, { ip: "127.0.0.1", userAgent: "e2e", method: "test" }).token,
  };
  cells.push(cell);
  await waitUp(port, proc, log);
  return cell;
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  O = await startCell(`own${sfx}`, "owner", 0);
  A = await startCell(`cella${sfx}`, "member", O.port);
  B = await startCell(`cellb${sfx}`, "member", O.port);
  LONELY = await startCell(`lone${sfx}`, "member", await freePort()); // nothing listens on its OWNER_PORT
});

test.afterAll(async () => {
  for (const c of cells) c.proc.kill("SIGTERM");
});

const url = (c: Cell, p: string) => `http://127.0.0.1:${c.port}${p}`;
const asUser = (c: Cell, extra: Record<string, string> = {}) => ({ cookie: `glos_session=${c.token}`, ...extra });
const call = (c: Cell, p: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  fetch(url(c, p), { redirect: "manual", ...init, headers: { ...asUser(c), ...(init.headers || {}) } });
const json = { "content-type": "application/json" };

test("leak test: B sees none of A's page, task or chat thread, and A's ids are 404 in B", async () => {
  const title = `Cell A secret ${sfx}`;
  const mk = async (p: string, body: object) => {
    const r = await call(A, p, { method: "POST", headers: json, body: JSON.stringify(body) });
    expect(r.status, p).toBeLessThan(300);
    return r.json();
  };
  const { task } = await mk("/api/tasks", { title });
  const { doc } = await mk("/api/docs", { title });
  const { thread } = await mk("/api/chat/threads", { title });

  // A (a member with no access to the accounts folder) is signed in, via the owner, and sees its own rows
  const aTasks = await (await call(A, "/api/tasks")).json();
  expect(JSON.stringify(aTasks)).toContain(title);

  for (const p of ["/api/tasks", "/api/docs", "/api/files", "/api/chat/threads", "/api/chat", "/api/schools", "/api/commitments", "/api/captures", "/api/today", "/api/agents"]) {
    const r = await call(B, p);
    const text = await r.text();
    expect(text, p).not.toContain(title);
    expect(text, p).not.toContain(sfx);
  }
  // B has its own database, so the same numeric id can exist there as one of B's OWN rows (e.g. a page B's cell
  // seeded at startup). What must never happen is B returning A's row: either 404, or a row that isn't A's.
  for (const p of [`/api/tasks/${task.id}`, `/api/docs/${doc.id}`]) {
    const r = await call(B, p);
    const text = await r.text();
    if (r.status !== 404) console.log(`[leak test] ${p} in B -> ${r.status}: ${text.slice(0, 160)}`);
    expect(text, p).not.toContain(title);
    expect(text, p).not.toContain(sfx);
  }
  const threads = await (await call(B, "/api/chat/threads")).json();
  expect((threads.threads || []).some((t: { id: number }) => t.id === thread.id)).toBe(false);
  const page = await (await call(B, "/files")).text();
  expect(page).not.toContain(title);
  // and the owner's own cell has none of it either
  expect(JSON.stringify(await (await call(O, "/api/tasks")).json())).not.toContain(title);
});

test("member cells never touch the accounts folder", async () => {
  expect(fs.existsSync(NO_ACCOUNTS)).toBe(false);
  expect(fs.existsSync(path.dirname(NO_ACCOUNTS))).toBe(false);
  for (const c of [A, B, LONELY]) {
    expect(fs.existsSync(path.join(c.dataDir, "auth-secret.key")), c.user).toBe(false);
    expect(c.log.join("")).not.toMatch(/only available in the owner cell/);
  }
  // each cell has its own random internal secret (mode 600), different from every other cell's
  const secrets = [O, A, B].map((c) => {
    const f = path.join(c.dataDir, "internal-secret.key");
    expect(fs.statSync(f).mode & 0o777, c.user).toBe(0o600);
    return fs.readFileSync(f, "utf8").trim();
  });
  expect(new Set(secrets).size).toBe(3);
});

test("wrong-cell guard: a session cookie sent to any other cell gets 401 (API) and a login redirect (pages)", async () => {
  for (const [from, to] of [[A, B], [B, A], [A, O], [O, A]] as [Cell, Cell][]) {
    const api = await fetch(url(to, "/api/tasks"), { headers: { cookie: `glos_session=${from.token}` } });
    expect(api.status, `${from.user} -> ${to.user}`).toBe(401);
    const page = await fetch(url(to, "/files"), { redirect: "manual", headers: { cookie: `glos_session=${from.token}` } });
    expect([301, 302, 303, 307, 308]).toContain(page.status);
    expect(page.headers.get("location") || "").toContain("/login");
  }
  expect((await fetch(url(B, "/api/tasks"))).status).toBe(401);
  for (const c of [O, A, B]) expect((await call(c, "/api/tasks")).status, c.user).toBe(200);
});

test("a forged X-Glos-User sent straight to a member cell is worthless without a valid cookie", async () => {
  for (const c of [A, B]) {
    for (const forged of [A.user, B.user, O.user, "owner"]) {
      const r = await fetch(url(c, "/api/tasks"), { headers: { "x-glos-user": forged } });
      expect(r.status, `${c.user} <- ${forged}`).toBe(401);
      const withBad = await fetch(url(c, "/api/tasks"), { headers: { "x-glos-user": c.user, cookie: "glos_session=not-a-session" } });
      expect(withBad.status).toBe(401);
    }
  }
  // B's valid cookie plus a forged header naming A is still B's cookie, and A rejects it
  const r = await fetch(url(A, "/api/tasks"), { headers: { cookie: `glos_session=${B.token}`, "x-glos-user": A.user } });
  expect(r.status).toBe(401);
});

test("/api/auth/check: owner answers 204 + X-Glos-User; member cells have no auth endpoints", async () => {
  const ok = await fetch(url(O, "/api/auth/check"), { headers: { cookie: `glos_session=${A.token}` } });
  expect(ok.status).toBe(204);
  expect(ok.headers.get("x-glos-user")).toBe(A.user); // the owner cell answers for ANY user's session
  const own = await fetch(url(O, "/api/auth/check"), { headers: { cookie: `glos_session=${O.token}` } });
  expect(own.headers.get("x-glos-user")).toBe(O.user);
  const bad = await fetch(url(O, "/api/auth/check"), { headers: { cookie: "glos_session=nope" } });
  expect(bad.status).toBe(401);
  expect(bad.headers.get("x-glos-user")).toBeNull();
  expect((await fetch(url(A, "/api/auth/check"), { headers: { cookie: `glos_session=${A.token}` } })).status).toBe(404);
  expect((await fetch(url(A, "/api/auth/login"), { method: "POST", headers: json, body: "{}" })).status).toBe(404);
});

test("owner unreachable means 401, never open", async () => {
  expect((await call(LONELY, "/api/tasks")).status).toBe(401);
  const page = await fetch(url(LONELY, "/files"), { redirect: "manual", headers: { cookie: `glos_session=${LONELY.token}` } });
  expect([301, 302, 303, 307, 308]).toContain(page.status);
});

test("a member session manages its own security settings through the owner, and cannot touch the owner's", async () => {
  const store = await import("../src/lib/auth/store");
  store.setPassword(A.user, "a-member-password-123");
  store.completeEnrollment(A.user); // A is enrolled, O (the stand-in for Owner) is not
  const ownerBefore = store.unusedBackupCodeCount(O.user);

  const sec = await fetch(url(O, "/api/auth/security"), { headers: { cookie: `glos_session=${A.token}` } });
  expect(sec.status).toBe(200);
  expect((await sec.json()).enrolled).toBe(true); // A's state, not the owner's
  const regen = await fetch(url(O, "/api/auth/security"), { method: "POST", headers: { ...json, cookie: `glos_session=${A.token}` }, body: JSON.stringify({ action: "regen_backup" }) });
  expect(regen.status).toBe(200);
  const { backupCodes } = await regen.json();
  expect(store.consumeBackupCode(A.user, backupCodes[0])).toBe(true); // the new codes belong to A
  expect(store.consumeBackupCode(O.user, backupCodes[1])).toBe(false); // and not to the owner
  expect(store.unusedBackupCodeCount(O.user)).toBe(ownerBefore);

  // setting up (or resetting) someone else's account is refused to a non-owner
  const setup = await fetch(url(O, "/api/auth/setup"), { method: "POST", headers: { ...json, cookie: `glos_session=${A.token}` }, body: JSON.stringify({ action: "password", user: O.user, password: "attacker-chosen-password" }) });
  expect(setup.status).toBe(403);
  expect(store.checkPassword(O.user, "attacker-chosen-password")).toBe(false);
  // the security PAGE opens for a member session on the owner cell, the rest of the owner's app does not
  expect((await fetch(url(O, "/security"), { redirect: "manual", headers: { cookie: `glos_session=${A.token}` } })).status).toBe(200);
  expect((await fetch(url(O, "/api/tasks"), { headers: { cookie: `glos_session=${A.token}` } })).status).toBe(401);
});

test("internal token: per cell, from the cell's own secret; A's is rejected by B", async () => {
  const { internalTokenFor, hasInternalToken, INTERNAL_HEADER } = await import("../src/lib/auth/policy");
  const tA = internalTokenFor(A.user, A.dataDir);
  const tB = internalTokenFor(B.user, B.dataDir);
  expect(tA).not.toBe(tB);
  // even the same user name in two cells gets different tokens
  expect(internalTokenFor("same", A.dataDir)).not.toBe(internalTokenFor("same", B.dataDir));
  // a cell compares against its own token only: evaluate the check as cell B, then as cell A
  const prevUser = process.env.GLOS_USER;
  try {
    process.env.GLOS_USER = B.user;
    expect(hasInternalToken({ [INTERNAL_HEADER]: tB }, B.dataDir)).toBe(true);
    expect(hasInternalToken({ [INTERNAL_HEADER]: tA }, B.dataDir)).toBe(false); // A's token is rejected by B
    process.env.GLOS_USER = A.user;
    expect(hasInternalToken({ [INTERNAL_HEADER]: tA }, A.dataDir)).toBe(true);
    expect(hasInternalToken({ [INTERNAL_HEADER]: tB }, A.dataDir)).toBe(false);
  } finally {
    if (prevUser === undefined) delete process.env.GLOS_USER;
    else process.env.GLOS_USER = prevUser;
  }
  // /api/schools is not open on loopback any more
  expect((await fetch(url(A, "/api/schools"))).status).toBe(401);
});
