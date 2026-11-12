import { NextRequest, NextResponse } from "next/server";
import { listAccounts, listInbox, getThread, sendEmail } from "@/lib/mail-accounts";
import { logIssue } from "@/lib/db";

// GET                              → unified recent inbox across all connected accounts.
// GET ?account=email               → recent inbox for one account.
// GET ?thread=ID&account=email     → full thread.
// GET ?q=term[&account=email]      → search (Gmail q= syntax on OAuth accounts, substring on legacy).
// With zero accounts connected this returns { accounts: [], messages: [] } without touching Google.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const accounts = listAccounts();
  const threadId = sp.get("thread");
  const accountParam = sp.get("account");

  try {
    if (threadId && accountParam) {
      return NextResponse.json({ messages: await getThread(accountParam, threadId) });
    }

    const q = sp.get("q")?.trim() || undefined;
    const limit = Number(sp.get("limit") || 20);
    const targets = (accountParam ? accounts.filter((a) => a.email === accountParam) : accounts).filter(
      (a) => a.status === "connected"
    );

    const perAccount = await Promise.all(
      targets.map(async (a) => {
        try {
          return await listInbox(a.email, { limit, q });
        } catch (err: any) {
          logIssue("email", `Couldn't load inbox for ${a.email}`, err.message);
          return [];
        }
      })
    );
    const messages = perAccount
      .flat()
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);

    return NextResponse.json({ accounts, messages });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, accounts }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { account, to, subject, text, threadId, inReplyTo, references } = await req.json();
  if (!account || !to || !text) {
    return NextResponse.json({ error: "account, to, and text are required" }, { status: 400 });
  }
  try {
    const result = await sendEmail({ account, to, subject: subject || "", text, threadId, inReplyTo, references });
    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
