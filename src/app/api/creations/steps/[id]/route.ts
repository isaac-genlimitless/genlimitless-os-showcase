import { decideStep, editStep } from "@/lib/creations/execution";
import { guarded, parseId, readJson } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

// { action: "approve" | "decline" | "done" } (owner), or { action: "edit", title?, details?, payload? }.
// Approve hands the step to Tasks, Communications (an email DRAFT) or the approval queue (a calendar request).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readJson(req);
  return guarded(async () => {
    const sid = parseId(id);
    if (body.action === "edit") {
      return { step: editStep(sid, { title: body.title, details: body.details, payload: body.payload }) };
    }
    return { step: await decideStep(sid, body.action) };
  });
}
