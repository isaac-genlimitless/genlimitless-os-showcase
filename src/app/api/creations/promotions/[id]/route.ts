import { decidePromotion, getPromotion, OWNER } from "@/lib/creations/store";
import { guarded, parseId, readJson } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return guarded(() => ({ promotion: getPromotion(parseId(id)) }));
}

// The only door to canon. A signed-in session is Owner (the app's single login); agents have no tool
// that reaches this route, and once collaborators can sign in they're refused in decidePromotion.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readJson(req);
  return guarded(() => ({ promotion: decidePromotion(parseId(id), body.decision, OWNER) }));
}
