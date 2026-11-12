// Which cell is this process? One process + one data folder per user (docs/multi-user.md).
// Unset env means today's single-user setup: Owner, owner.
import { NextResponse } from "next/server";

export type GlosRole = "owner" | "member";

export function glosUser(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GLOS_USER || "").trim() || "owner";
}

export function glosRole(env: NodeJS.ProcessEnv = process.env): GlosRole {
  // Fail closed: owner only for exactly "owner", or the legacy single-user setup where neither var is set.
  // A member cell whose env forgot (or misspelled) GLOS_ROLE must never get self-build/deploy.
  if (env.GLOS_ROLE === "owner") return "owner";
  if (env.GLOS_USER === undefined && env.GLOS_ROLE === undefined) return "owner";
  return "member";
}

export function isOwnerCell(env: NodeJS.ProcessEnv = process.env): boolean {
  return glosRole(env) === "owner";
}

/** Display name of this cell's user, used in agent prompts and UI strings. Phase 1A's accounts.db can feed it later. */
export function ownerName(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GLOS_DISPLAY_NAME || "").trim() || "Owner";
}

/** Replace the hardcoded owner name in a prompt/UI string. */
export function nameFor(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const n = ownerName(env);
  return n === "Owner" ? text : text.replace(/\bOwner\b/g, n);
}

const notFound = () => new NextResponse(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });

/** Wrap a route handler so it returns 404 in a member cell. Owner cells run it unchanged. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ownerOnly<F extends (...args: any[]) => any>(handler: F): F {
  return ((...args: unknown[]) => (isOwnerCell() ? handler(...args) : notFound())) as unknown as F;
}
