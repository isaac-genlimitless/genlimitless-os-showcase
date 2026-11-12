import { proposePromotion } from "@/lib/creations/store";
import { guarded, parseId, readJson } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readJson(req);
  return guarded(() => ({ promotion: proposePromotion(parseId(id), body) }), 201);
}
