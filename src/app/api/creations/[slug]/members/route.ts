import { inviteMember, listMembers, removeMember } from "@/lib/creations/people";
import { guarded, readJson } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  return guarded(() => ({ members: listMembers(slug) }));
}

// { name, role } invites (the private link token is returned only when a new one was made);
// { action: "remove", person } takes someone off this creation.
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const body = await readJson(req);
  return guarded(() => {
    if (body.action === "remove") {
      removeMember(slug, String(body.person ?? ""));
      return { ok: true };
    }
    return inviteMember(slug, body);
  });
}
