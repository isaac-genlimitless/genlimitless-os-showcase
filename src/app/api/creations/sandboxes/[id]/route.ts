import { archiveSandbox, getSandbox, rebaseSandbox } from "@/lib/creations/store";
import { guarded, parseId, readJson } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return guarded(() => getSandbox(parseId(id)));
}

// { action: "archive" } or { action: "rebase" }. Nothing is deleted.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readJson(req);
  return guarded(() => {
    const sid = parseId(id);
    if (body.action === "archive") return { sandbox: archiveSandbox(sid) };
    if (body.action === "rebase") return rebaseSandbox(sid);
    throw new Error("action must be archive or rebase");
  });
}
