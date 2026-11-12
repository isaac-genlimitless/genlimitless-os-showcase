import { saveArtifact } from "@/lib/creations/store";
import { guarded, parseId, readJson } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

// Create or update an artifact inside a sandbox ({ archived: true, key } archives it). Canon is never touched.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readJson(req);
  return guarded(() => ({ artifact: saveArtifact(parseId(id), body) }));
}
