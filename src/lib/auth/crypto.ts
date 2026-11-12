import crypto from "crypto";
import fs from "fs";
import path from "path";
import { DATA_DIR } from "../data-dir";
import { accountsDir, AUTH_SECRET_FILE } from "../accounts/dir";
import { assertOwnsAccounts, ownsAccounts } from "../accounts/identity";

export const MIN_PASSWORD_LENGTH = 12;

let secretCache: string | null = null;

/** The signing secret. Lives in ACCOUNTS_DIR/auth-secret.key, shared by every cell. AUTH_CODE_SECRET /
 *  SESSION_SECRET override it. On an old single-user install whose key is still in the data folder, that file is
 *  copied across once (scripts/accounts-migrate.mjs does the same on purpose). */
export function authSecret(): string {
  assertOwnsAccounts("The auth secret");
  const env = process.env.AUTH_CODE_SECRET || process.env.SESSION_SECRET;
  if (env) return env;
  if (secretCache) return secretCache;
  const dir = accountsDir();
  const file = path.join(dir, AUTH_SECRET_FILE);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    let seed = "";
    try {
      seed = fs.readFileSync(path.join(DATA_DIR, AUTH_SECRET_FILE), "utf8").trim();
    } catch {}
    try {
      fs.writeFileSync(file, seed || crypto.randomBytes(32).toString("hex"), { mode: 0o640, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  secretCache = fs.readFileSync(file, "utf8").trim();
  return secretCache;
}

const INTERNAL_SECRET_FILE = "internal-secret.key";
const internalCache = new Map<string, string>();

/** This cell's own random secret, in its own data folder (mode 600). Never shared, never derived from the auth secret:
 *  it is the base of the loopback token and, in member cells, of at-rest sealing. */
export function internalSecret(dataDir: string = DATA_DIR): string {
  const hit = internalCache.get(dataDir);
  if (hit) return hit;
  const file = path.join(dataDir, INTERNAL_SECRET_FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const v = fs.readFileSync(file, "utf8").trim();
  internalCache.set(dataDir, v);
  return v;
}

export function hmacHex(s: string): string {
  return crypto.createHmac("sha256", authSecret()).update(s).digest("hex");
}

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return "scrypt$16384$8$1$" + salt.toString("base64") + "$" + h.toString("base64");
}

export function verifyPassword(pw: string, stored: string): boolean {
  try {
    const parts = String(stored).split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    if (salt.length === 0 || expected.length === 0) return false;
    const got = crypto.scryptSync(pw, salt, expected.length, { N, r, p });
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

const BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generateBackupCodes(n?: number): string[] {
  const count = n === undefined ? 10 : n;
  const out: string[] = [];
  const seen = new Set<string>();
  while (out.length < count) {
    let c = "";
    for (let i = 0; i < 8; i++) {
      if (i === 4) c += "-";
      c += BACKUP_ALPHABET[crypto.randomInt(BACKUP_ALPHABET.length)];
    }
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

export function normalizeBackupCode(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(b: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < b.length; i++) {
    value = (value << 8) | b[i];
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=]/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < clean.length; i++) {
    const idx = B32.indexOf(clean[i]);
    if (idx < 0) throw new Error("bad_base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

function stepOf(timeMs: number): number {
  return Math.floor(timeMs / 1000 / 30);
}

function totpAtStep(secretB32: string, step: number, digits: number): string {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const h = crypto.createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  const mod = Math.pow(10, digits);
  return String(bin % mod).padStart(digits, "0");
}

export function totp(secretB32: string, timeMs: number, digits?: number): string {
  return totpAtStep(secretB32, stepOf(timeMs), digits === undefined ? 6 : digits);
}

export function verifyTotp(secretB32: string, code: string, timeMs: number, lastStep: number): number | null {
  const clean = String(code).replace(/\s/g, "");
  if (!/^[0-9]{6}$/.test(clean)) return null;
  const cur = stepOf(timeMs);
  let matched: number | null = null;
  for (let d = -1; d <= 1; d++) {
    const step = cur + d;
    if (step <= lastStep) continue;
    const exp = totpAtStep(secretB32, step, 6);
    if (crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(clean)) && matched === null) matched = step;
  }
  return matched;
}

export function newTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function otpauthUri(secretB32: string, label: string = "Owner"): string {
  return "otpauth://totp/GenLimitless%20OS:" + encodeURIComponent(label) + "?secret=" + secretB32 + "&issuer=GenLimitless%20OS&digits=6&period=30";
}

// Owner cell: keyed by the auth secret, exactly as before (existing sealed tokens and the TOTP secret keep decrypting).
// Member cells never see the auth secret, so they seal with their own cell secret.
function totpKey(): Buffer {
  const base = ownsAccounts() ? authSecret() : internalSecret();
  return crypto.createHash("sha256").update(base + ":totp").digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", totpKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return iv.toString("base64url") + "." + tag.toString("base64url") + "." + ct.toString("base64url");
}

export function decryptSecret(enc: string): string {
  const parts = enc.split(".");
  if (parts.length !== 3) throw new Error("bad_secret");
  const d = crypto.createDecipheriv("aes-256-gcm", totpKey(), Buffer.from(parts[0], "base64url"));
  d.setAuthTag(Buffer.from(parts[1], "base64url"));
  return Buffer.concat([d.update(Buffer.from(parts[2], "base64url")), d.final()]).toString("utf8");
}
