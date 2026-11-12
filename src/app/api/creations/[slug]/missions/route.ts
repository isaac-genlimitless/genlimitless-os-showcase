import { budgetStatus, createMission, listMissions, ROLES, runDueMissions } from "@/lib/creations/missions";
import { guarded, readJson } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  return guarded(() => ({
    missions: listMissions(slug),
    budget: budgetStatus(),
    roles: Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label, charter: r.charter })),
  }));
}

// { role, goal, budget?, when: "now" | "tonight" }. "now" starts it in the background unless the scheduler
// is disabled (test servers), in which case it just stays queued.
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const body = await readJson(req);
  return guarded(() => {
    const mission = createMission(slug, body);
    if (body.when !== "tonight" && process.env.DISABLE_SCHEDULER !== "1") void runDueMissions().catch(() => {});
    return { mission };
  }, 201);
}
