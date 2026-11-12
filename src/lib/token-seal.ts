import { encryptSecret, decryptSecret } from "@/lib/auth/crypto";

const PREFIX = "enc:v1:";

export function isSealed(v: string | null | undefined): boolean {
  return !!v && v.startsWith(PREFIX);
}

export function sealToken(plain: string | null | undefined): string | null {
  if (!plain) return plain ?? null;
  return isSealed(plain) ? plain : PREFIX + encryptSecret(plain);
}

// Legacy plaintext values pass through unchanged so nothing breaks mid-migration.
export function openToken(v: string | null | undefined): string | null {
  if (!v) return v ?? null;
  return isSealed(v) ? decryptSecret(v.slice(PREFIX.length)) : v;
}
