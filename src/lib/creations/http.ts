import { NextResponse } from "next/server";
import { ensureCreationsSchema } from "./store";

/** Runs a handler after the schema is ready; thrown validation errors become 400s ("not found" → 404, owner-only → 403). */
export async function guarded(fn: () => unknown | Promise<unknown>, okStatus = 200) {
  try {
    await ensureCreationsSchema();
    return NextResponse.json(await fn(), { status: okStatus });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unexpected error";
    const status = /not found/i.test(msg) ? 404 : /only the owner/i.test(msg) ? 403 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error("invalid id");
  return n;
}
