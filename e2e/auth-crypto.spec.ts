import { test, expect } from "@playwright/test";
import { totp, verifyTotp, hashPassword, verifyPassword, generateBackupCodes, normalizeBackupCode, base32Encode, base32Decode, encryptSecret, decryptSecret } from "../src/lib/auth/crypto";
process.env.AUTH_CODE_SECRET = "e2e-only-not-a-real-secret";

const S = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("RFC 6238 vectors", () => {
  expect(totp(S, 59_000, 8)).toBe("94287082");
  expect(totp(S, 1111111109_000, 8)).toBe("07081804");
  expect(totp(S, 1234567890_000, 8)).toBe("89005924");
  expect(totp(S, 59_000)).toBe("287082");
});

test("verifyTotp accepts once, blocks replay, rejects wrong code", () => {
  const t = 1234567890_000;
  const step = Math.floor(t / 1000 / 30);
  const code = totp(S, t);
  expect(verifyTotp(S, code, t, 0)).toBe(step);
  expect(verifyTotp(S, code, t, step)).toBeNull();
  const wrong = code === "000000" ? "000001" : "000000";
  expect(verifyTotp(S, wrong, t, 0)).toBeNull();
});

test("password hashing", () => {
  const h = hashPassword("correct horse battery");
  expect(verifyPassword("correct horse battery", h)).toBe(true);
  expect(verifyPassword("wrong password here", h)).toBe(false);
  expect(verifyPassword("x", "garbage")).toBe(false);
  expect(verifyPassword("x", "scrypt$a$b$c$d$e")).toBe(false);
});

test("backup codes", () => {
  const codes = generateBackupCodes();
  expect(codes.length).toBe(10);
  expect(new Set(codes).size).toBe(10);
  for (const c of codes) expect(c).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
  expect(normalizeBackupCode(" AB2C-dE3f ")).toBe("ab2cde3f");
});

test("base32 and secret encryption round trip", () => {
  const b = Buffer.from([1, 2, 3, 250, 251, 252, 0, 9]);
  expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  expect(decryptSecret(encryptSecret("x"))).toBe("x");
});
