import { getMission, stopMission } from "@/lib/creations/missions";
import { guarded, parseId, readJson } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return guarded(() => ({ mission: getMission(parseId(id)) }));
}

// { action: "stop" } cancels a queued mission or stops a running one.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readJson(req);
  return guarded(() => {
    if (body.action !== "stop") throw new Error("action must be stop");
    return { mission: stopMission(parseId(id)) };
  });
}
