import { NextRequest, NextResponse } from "next/server";
import { challengeUser } from "@/lib/auth/store";
import { issueLoginCode } from "@/lib/auth/second-factor";
import { CHALLENGE_COOKIE } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const challengeId = req.cookies.get(CHALLENGE_COOKIE)?.value || "";
  const userId = challengeUser(challengeId);
  if (!userId) return NextResponse.json({ error: "no_challenge" }, { status: 401 });
  const result = await issueLoginCode(userId, challengeId);
  if (result.ok) return NextResponse.json({ ok: true });
  return NextResponse.json({ ok: false, reason: result.reason });
}
