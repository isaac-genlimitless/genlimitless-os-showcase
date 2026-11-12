import { regenerateLink, revokeLink } from "@/lib/creations/people";
import { guarded, readJson } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

// Owner's session only. { action: "regenerate" } → a new private link (the old one stops working);
// { action: "revoke" } → their link stops working everywhere.
export async function POST(req: Request, ctx: { params: Promise<{ person: string }> }) {
  const { person } = await ctx.params;
  const body = await readJson(req);
  return guarded(() => {
    if (body.action === "regenerate") return { token: regenerateLink(person) };
    if (body.action === "revoke") {
      revokeLink(person);
      return { ok: true };
    }
    throw new Error("action must be regenerate or revoke");
  });
}
