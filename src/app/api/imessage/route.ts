import { NextRequest, NextResponse } from "next/server";
import { logIssue } from "@/lib/db";
import {
  AccessError,
  chatIdForHandle,
  getThreadMessages,
  listThreads,
  searchContacts,
  searchMessages,
} from "@/lib/imessage";
import { searchIndexed } from "@/lib/msg-index";
import { trackedIMessage } from "@/lib/delivery";
import { listAccounts, searchMail } from "@/lib/mail-accounts";
import { isOwnerCell } from "@/lib/instance";

const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

const NO_ACCESS = {
  error: "no_access",
  hint: "Grant Full Disk Access (System Settings → Privacy & Security) to the app running `npm run dev`, then restart it.",
};

// GET                 → recent threads
// GET ?chat=ID        → messages in a thread
// GET ?handle=+1555…  → resolve a contact handle to its thread
// GET ?q=term         → search contacts and Apple messages
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  // Member cells have no Messages bridge; only the email-search scope (used by Communications) works there.
  if (!isOwnerCell() && !(sp.get("q")?.trim() && sp.get("scope") === "email")) return notFound();
  try {
    const chat = sp.get("chat");
    if (chat) return NextResponse.json({ messages: getThreadMessages(Number(chat)) });

    const handle = sp.get("handle");
    if (handle) return NextResponse.json({ chat_id: chatIdForHandle(handle) });

    const q = sp.get("q")?.trim();

    // Email search opens live connections to Gmail (~2-5 s), so the UI requests it separately
    // and the instant results (contacts, texts) never wait on it.
    if (q && sp.get("scope") === "email") {
      const perAccount = await Promise.all(
        listAccounts().map(async (a) => {
          try {
            return await searchMail(a.email, { folder: "inbox", q, limit: 10 });
          } catch (err: any) {
            logIssue("email", `Couldn't search inbox for ${a.email}`, err.message);
            return [];
          }
        })
      );
      const email = perAccount.flat().sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      return NextResponse.json({ email });
    }

    if (q) {
      let contacts: unknown[] = [];
      let messages: unknown[] = [];
      let access = true;
      try {
        contacts = searchContacts(q);
      } catch (e) {
        if (!(e instanceof AccessError)) throw e;
        access = false;
      }
      try {
        // Millisecond FTS lookup once the background index is built; slow scan until then.
        messages = searchIndexed(q) ?? searchMessages(q);
      } catch (e) {
        if (!(e instanceof AccessError)) throw e;
        access = false;
      }
      return NextResponse.json({ contacts, messages, email: [], access });
    }

    return NextResponse.json({ threads: listThreads() });
  } catch (err: any) {
    if (err instanceof AccessError) return NextResponse.json(NO_ACCESS, { status: 403 });
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isOwnerCell()) return notFound();
  const { to, chat_guid, text } = await req.json();
  if (!text || (!to && !chat_guid)) {
    return NextResponse.json({ error: "text and (to or chat_guid) are required" }, { status: 400 });
  }
  try {
    const send_id = await trackedIMessage({ to, chatGuid: chat_guid, text, purpose: "manual" });
    return NextResponse.json({ ok: true, send_id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
