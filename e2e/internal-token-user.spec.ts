import { test, expect } from "@playwright/test";
import { internalTokenFor, internalToken, hasInternalToken, decide, INTERNAL_HEADER } from "../src/lib/auth/policy";

// The loopback token is per user: hmac(secret, "internal:" + GLOS_USER). Pure functions plus the live test server.
// Sends nothing, triggers no agent.

test("each user's internal token differs, and a cell accepts only its own", () => {
  const prev = process.env.GLOS_USER;
  try {
    const a = internalTokenFor("cell-a");
    const b = internalTokenFor("cell-b");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    process.env.GLOS_USER = "cell-a";
    expect(internalToken()).toBe(a);
    expect(hasInternalToken({ [INTERNAL_HEADER]: a })).toBe(true);
    expect(hasInternalToken({ [INTERNAL_HEADER]: b })).toBe(false); // B's token is rejected by A
    process.env.GLOS_USER = "cell-b";
    expect(hasInternalToken({ [INTERNAL_HEADER]: a })).toBe(false);
    expect(hasInternalToken({ [INTERNAL_HEADER]: b })).toBe(true);
    // unset = owner
    delete process.env.GLOS_USER;
    expect(internalToken()).toBe(internalTokenFor("owner"));
  } finally {
    if (prev === undefined) delete process.env.GLOS_USER;
    else process.env.GLOS_USER = prev;
  }
});

test("policy: with login enforced, loopback needs THIS user's token", () => {
  const prev = process.env.GLOS_USER;
  try {
    process.env.GLOS_USER = "cell-a";
    const base = { path: "/api/tasks", method: "GET", enrolled: true, enforce: true, breakGlass: false, sessionValid: false };
    const loop = { host: "127.0.0.1:3110" };
    expect(decide({ ...base, headers: { ...loop, [INTERNAL_HEADER]: internalTokenFor("cell-a") } })).toBe("allow");
    expect(decide({ ...base, headers: { ...loop, [INTERNAL_HEADER]: internalTokenFor("cell-b") } })).toBe("unauthorized");
    expect(decide({ ...base, headers: { ...loop, [INTERNAL_HEADER]: internalTokenFor("owner") } })).toBe("unauthorized");
    expect(decide({ ...base, headers: loop })).toBe("unauthorized");
    // /api/schools is not a health path any more
    expect(decide({ ...base, path: "/api/schools", headers: loop })).toBe("unauthorized");
    expect(decide({ ...base, path: "/api/health", headers: loop })).toBe("allow");
    // check and logout answer for any user's cookie (nginx asks the owner cell about everyone)
    expect(decide({ ...base, path: "/api/auth/check", headers: {} })).toBe("allow");
    expect(decide({ ...base, path: "/api/auth/logout", method: "POST", headers: {} })).toBe("allow");
  } finally {
    if (prev === undefined) delete process.env.GLOS_USER;
    else process.env.GLOS_USER = prev;
  }
});
