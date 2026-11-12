import { getVersion } from "@/lib/creations/store";
import { guarded, parseId } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return guarded(() => getVersion(parseId(id)));
}
