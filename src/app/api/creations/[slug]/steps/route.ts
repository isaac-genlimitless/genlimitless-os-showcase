import { listSteps, proposeStep } from "@/lib/creations/execution";
import { guarded, readJson } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  return guarded(() => ({ steps: listSteps(slug) }));
}

// Propose a step: { kind, title, details?, payload? }. Proposing does nothing outside The Creation.
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const body = await readJson(req);
  return guarded(() => ({ step: proposeStep(slug, body) }), 201);
}
