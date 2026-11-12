import { createSandbox } from "@/lib/creations/store";
import { guarded, readJson } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const body = await readJson(req);
  return guarded(() => ({ sandbox: createSandbox(slug, body) }), 201);
}
