import { sha256 } from "./hash";

// Member cells never open accounts.db. They ask the owner cell, over loopback, who a session cookie belongs to.
// Only a 204 whose X-Glos-User equals this cell's user counts. Anything else (401, error, timeout, owner down) is a no.

export const OWNER_CHECK_TTL_MS = 30_000;
const FAIL_TTL_MS = 5_000;

export type OwnerAnswer = { ok: boolean; slid: boolean; imp?: "ro" | "rw"; by?: string };
const cache = new Map<string, { at: number; ok: boolean; imp?: "ro" | "rw"; by?: string }>();

export function ownerPort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OWNER_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3100;
}

export function clearOwnerCheckCache(): void {
  cache.clear();
}

export async function askOwner(
  token: string,
  user: string,
  opts: { port?: number; now?: number; fetchImpl?: typeof fetch } = {}
): Promise<OwnerAnswer> {
  const now = opts.now ?? Date.now();
  const key = sha256(user + ":" + token);
  const hit = cache.get(key);
  if (hit && now - hit.at < (hit.ok ? OWNER_CHECK_TTL_MS : FAIL_TTL_MS)) return { ok: hit.ok, slid: false, imp: hit.ok ? hit.imp : undefined, by: hit.ok ? hit.by : undefined };
  let ok = false;
  let slid = false;
  let imp: "ro" | "rw" | undefined;
  let by: string | undefined;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`http://127.0.0.1:${opts.port ?? ownerPort()}/api/auth/check`, {
      headers: { cookie: `glos_session=${token}` },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    ok = res.status === 204 && res.headers.get("x-glos-user") === user;
    slid = ok && res.headers.get("x-glos-slid") === "1";
    if (ok) {
      const i = res.headers.get("x-glos-imp");
      if (i === "ro" || i === "rw") {
        imp = i;
        by = res.headers.get("x-glos-impersonator") || undefined;
      }
    }
  } catch {
    ok = false; // owner unreachable: fail closed
    slid = false;
    imp = undefined;
    by = undefined;
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: now, ok, imp, by });
  return { ok, slid, imp, by };
}
