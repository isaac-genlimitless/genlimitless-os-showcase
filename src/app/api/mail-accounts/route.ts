import { NextRequest, NextResponse } from "next/server";
import { listAccounts, disconnectAccount } from "@/lib/mail-accounts";

// GET                         → connected accounts + whether Google OAuth is configured at all.
// POST { action: "disconnect", email } → revoke at Google and remove the account.
export async function GET() {
  return NextResponse.json({ accounts: listAccounts(), configured: !!process.env.GOOGLE_CLIENT_ID });
}

export async function POST(req: NextRequest) {
  const { action, email } = await req.json();
  if (action !== "disconnect" || !email) {
    return NextResponse.json({ error: "action must be 'disconnect' and email is required" }, { status: 400 });
  }
  try {
    await disconnectAccount(email);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
