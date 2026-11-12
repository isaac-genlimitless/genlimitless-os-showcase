import { ownerName } from "@/lib/instance";
import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { runAgent } from "@/lib/agent";
import { saveUploadedFile, extractAttachmentText, describeAttachmentsForPrompt, StoredAttachment } from "@/lib/attachments";
import { validateChatFiles } from "@/lib/chat-upload-limits";
import { withScheduleReviewFences } from "@/lib/schedule";
import { buildViewingNote } from "@/lib/viewing-note";
import { stashScreen } from "@/lib/screen-context";
import { buildMentionContext, extractMentionRefs } from "@/lib/mentions";
import { chatEffort, chatModel } from "@/lib/chat-options";
import { linkChatTurn } from "@/lib/undo-log";
import { autoTitle, threadKey, getThread, isRunning, listOpenThreads, runningKeys, setRunning, threadMessages } from "@/lib/chat-threads";

// ?thread=<id> reads/writes a side chat; no thread = the main feed.
function threadParam(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(req: NextRequest) {
  const threadId = threadParam(req.nextUrl.searchParams.get("thread"));
  const undoByChat = new Map<number, "available" | "undone">();
  const rows = threadMessages(threadId);
  // Undo state only for the assistant messages being returned (this runs on every chat poll; it used
  // to total every chat turn ever, which got slower as the history grew).
  const assistantIds = rows.filter((r) => r.role === "assistant").map((r) => r.id);
  if (assistantIds.length) {
    try {
      const grouped = db
        .prepare(
          `SELECT t.chat_id AS chat_id,
                  SUM(CASE WHEN u.undoable=1 AND u.state='recorded' THEN 1 ELSE 0 END) AS rec,
                  SUM(CASE WHEN u.undoable=1 THEN 1 ELSE 0 END) AS rev,
                  SUM(CASE WHEN u.undoable=1 AND u.state='undone' THEN 1 ELSE 0 END) AS und
           FROM chat_turn_runs t JOIN undo_actions u ON u.root_run_id = t.run_id
           WHERE t.chat_id IN (${assistantIds.map(() => "?").join(",")}) GROUP BY t.chat_id`
        )
        .all(...assistantIds) as { chat_id: number; rec: number; rev: number; und: number }[];
      for (const g of grouped) if (g.rev > 0) undoByChat.set(g.chat_id, g.rec > 0 ? "available" : "undone");
    } catch {
      /* undo tables don't exist yet: no message has an undo */
    }
  }
  const messages = rows.map((r) => ({
    id: r.id,
    meta: r.meta ? JSON.parse(r.meta) : null,
    role: r.role,
    content: r.content,
    attachments: r.attachments ? JSON.parse(r.attachments) : [],
    ...(r.role === "assistant" ? { undo: { state: undoByChat.get(r.id) ?? "none" } } : {}),
  }));
  return NextResponse.json({ messages, threads: listOpenThreads(), running: runningKeys() });
}

const MAIN_CONTEXT = 8;
const RECENT_MESSAGES = 15;
const MAX_MESSAGE_CHARS = 2500;

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const message = form.get("message");
  const files = form.getAll("files") as File[];
  const threadId = threadParam(form.get("thread_id"));

  if (typeof message !== "string") {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  if (threadId) {
    const t = getThread(threadId);
    if (!t || t.status !== "open") return NextResponse.json({ error: "That chat is closed." }, { status: 400 });
  }
  if (isRunning(threadId)) {
    return NextResponse.json(
      { error: "Still working on the last message in this chat. Open a new chat to do something else in the meantime." },
      { status: 409 }
    );
  }

  const real = files.filter((f) => f instanceof File && f.size > 0);
  const check = validateChatFiles(real);
  if (check.rejected.length > 0) {
    return NextResponse.json({ error: check.rejected.map((r) => r.reason).join("; ") }, { status: 400 });
  }

  const attachments: StoredAttachment[] = [];
  for (const file of files) {
    if (file instanceof File && file.size > 0) {
      const att = await saveUploadedFile(file);
      await extractAttachmentText(att);
      attachments.push(att);
    }
  }

  if (!message.trim() && attachments.length === 0) {
    return NextResponse.json({ error: "message or a file is required" }, { status: 400 });
  }

  const messageText = message.trim() || "(see attached file)";

  db.prepare(`INSERT INTO chat_history (role, content, attachments, thread_id) VALUES ('user', ?, ?, ?)`).run(
    messageText,
    attachments.length > 0 ? JSON.stringify(attachments) : null,
    threadId
  );
  if (threadId) autoTitle(threadId, messageText);

  // Newest 200 of this conversation, oldest-first.
  // Only the recent conversation goes to the Chief of Staff (it's re-read on every step, so the old
  // 200-message history cost ~37k tokens per step). Older history: search_chat_history on demand.
  const recent = threadMessages(threadId, RECENT_MESSAGES);
  const history = [
    ...(recent.length === RECENT_MESSAGES
      ? [{ role: "user" as const, content: "(Earlier conversation isn't shown. If this request refers to something from before, look it up with search_chat_history.)" }]
      : []),
    ...recent.map((r) => ({
      role: r.role as "user" | "assistant",
      content: r.content.length > MAX_MESSAGE_CHARS ? `${r.content.slice(0, MAX_MESSAGE_CHARS)}… (trimmed)` : r.content,
    })),
  ];

  // A side chat starts with a glimpse of the main chat, so "that campaign" or "the thing I just
  // asked for" still makes sense there.
  let prefix = "";
  if (threadId) {
    const main = threadMessages(null, MAIN_CONTEXT)
      .map((r) => `${r.role === "user" ? ownerName() : "You"}: ${r.content.slice(0, 800)}`)
      .join("\n\n");
    prefix = `[This is a SIDE CHAT Owner opened while the main chat${isRunning(null) ? " is busy on another task" : " is open"}. It will be merged into the main chat when he closes it. Recent main chat, for context only:]\n\n${main || "(empty)"}\n\n[Side chat starts here:]\n\n`;
  }

  // Sent from the docked chat: what Owner has open, so "this page" / "this meeting" resolves.
  const viewingNote = buildViewingNote(form.get("context"), form.get("surface") === "main" ? "main" : "sidebar");

  // Items tagged with @ in this message (links to /files, /meetings, /tasks): titles + short
  // summaries as data. Not stored; the stored message is unchanged.
  const mentionContext = buildMentionContext(extractMentionRefs(messageText));
  const mentionNote = mentionContext ? `\n\n${mentionContext}` : "";

  // The page text is NOT put in the prompt: it is stashed for Chief's read_current_screen tool.
  stashScreen(form.get("context"), form.get("screen"));
  const attachmentNote = describeAttachmentsForPrompt(attachments) + viewingNote + mentionNote;

  const startedAt = (db.prepare("SELECT datetime('now') AS t").get() as { t: string }).t;
  setRunning(threadId, true);
  let reply: string;
  let runId: number | null = null;
  try {
    // Model and effort picked in the chat box (blank or unknown = the OS default).
    reply = await runAgent(history, attachmentNote, prefix, threadKey(threadId), {
      model: chatModel(form.get("model")),
      effort: chatEffort(form.get("effort")),
      onRunId: (id) => {
        runId = id;
      },
    });
  } catch (err: any) {
    reply = `Something went wrong: ${err.message}`;
  } finally {
    setRunning(threadId, false);
  }

  // If the agent proposed a schedule during this request, attach the review-card fence so the card
  // shows in this reply and after a refresh (the stored content includes it).
  try {
    reply = withScheduleReviewFences(reply, startedAt);
  } catch {
    // never lose the reply over the card
  }

  const inserted = db.prepare(`INSERT INTO chat_history (role, content, thread_id) VALUES ('assistant', ?, ?)`).run(reply, threadId);
  const linkedRun = runId as number | null; // assigned inside the onRunId callback
  if (linkedRun != null) await linkChatTurn(Number(inserted.lastInsertRowid), linkedRun, threadKey(threadId));

  return NextResponse.json({ reply, attachments });
}
