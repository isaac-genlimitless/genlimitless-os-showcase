import { getCreation, setPhase } from "@/lib/creations/store";
import { guarded, readJson } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  return guarded(() => getCreation(slug));
}

// Only the phase is editable here. Canon content changes only through an approved promotion.
export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const body = await readJson(req);
  return guarded(() => ({ creation: setPhase(slug, body.phase) }));
}
