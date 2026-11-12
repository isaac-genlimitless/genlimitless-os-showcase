import { NextRequest, NextResponse } from "next/server";
import { ownerOnly } from "@/lib/instance";
import { listUsers, listAudit } from "@/lib/accounts/admin";
import { adminContext, adminError } from "@/lib/accounts/admin-http";

export const dynamic = "force-dynamic";

export const GET = ownerOnly(async (req: NextRequest): Promise<NextResponse> => {
  const c = adminContext(req);
  if (c instanceof NextResponse) return c;
  const q = req.nextUrl.searchParams;
  try {
    if (q.get("audit") === "1") return NextResponse.json({ audit: listAudit(c.actor, Number(q.get("limit")) || 200) });
    return NextResponse.json({ users: listUsers(c.actor, { includeRemoved: q.get("removed") === "1" }) });
  } catch (e) {
    return adminError(e);
  }
});
