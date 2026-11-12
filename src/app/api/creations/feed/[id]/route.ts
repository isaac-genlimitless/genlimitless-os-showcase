import { resolveComment } from "@/lib/creations/store";
import { guarded, parseId, readJson } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

// { action: "resolve" } moves a comment to history.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readJson(req);
  return guarded(() => {
    if (body.action !== "resolve") throw new Error("action must be resolve");
    resolveComment(parseId(id));
    return { ok: true };
  });
}
