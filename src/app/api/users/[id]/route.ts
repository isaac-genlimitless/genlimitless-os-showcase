import { NextRequest, NextResponse } from "next/server";
import { ownerOnly } from "@/lib/instance";
import { updateUser, changeRole, setStatus, removeUser, restoreUser } from "@/lib/accounts/admin";
import { adminContext, adminError } from "@/lib/accounts/admin-http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

async function readBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const b: unknown = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

// PATCH {display_name?, email?, phone?}  OR  {role}  (role alone, so a request is never half-applied)
export const PATCH = ownerOnly(async (req: NextRequest, { params }: Ctx): Promise<NextResponse> => {
  const c = adminContext(req);
  if (c instanceof NextResponse) return c;
  const { id } = await params;
  const body = await readBody(req);
  if (!body) return bad("bad_request");
  const hasProfile = "display_name" in body || "email" in body || "phone" in body;
  try {
    if ("role" in body) {
      if (hasProfile) return bad("role_must_be_alone");
      if (body.role !== "owner" && body.role !== "member") return bad("bad_role");
      return NextResponse.json({ user: changeRole(c.actor, id, body.role, c.ip) });
    }
    if (!hasProfile) return bad("nothing_to_update");
    const patch: { display_name?: string; email?: string | null; phone?: string | null } = {};
    if ("display_name" in body) { if (typeof body.display_name !== "string") return bad("bad_name"); patch.display_name = body.display_name; }
    if ("email" in body) { if (body.email !== null && typeof body.email !== "string") return bad("bad_email"); patch.email = body.email; }
    if ("phone" in body) { if (body.phone !== null && typeof body.phone !== "string") return bad("bad_phone"); patch.phone = body.phone; }
    return NextResponse.json({ user: updateUser(c.actor, id, patch, c.ip) });
  } catch (e) {
    return adminError(e);
  }
});

// POST {action: "deactivate"|"reactivate"|"remove"|"restore"}   (remove is SOFT; restore brings the user back)
export const POST = ownerOnly(async (req: NextRequest, { params }: Ctx): Promise<NextResponse> => {
  const c = adminContext(req);
  if (c instanceof NextResponse) return c;
  const { id } = await params;
  const body = await readBody(req);
  if (!body) return bad("bad_request");
  try {
    switch (body.action) {
      case "deactivate": return NextResponse.json({ user: setStatus(c.actor, id, "disabled", c.ip) });
      case "reactivate": return NextResponse.json({ user: setStatus(c.actor, id, "active", c.ip) });
      case "remove": return NextResponse.json({ user: removeUser(c.actor, id, c.ip) });
      case "restore": return NextResponse.json({ user: restoreUser(c.actor, id, c.ip) });
      default: return bad("bad_action");
    }
  } catch (e) {
    return adminError(e);
  }
});
