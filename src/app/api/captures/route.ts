import { NextRequest, NextResponse } from "next/server";
import { createCapture, listCaptures, processCapture } from "@/lib/captures";
import { saveUploadedFile, extractAttachmentText, StoredAttachment } from "@/lib/attachments";
import { validateChatFiles } from "@/lib/chat-upload-limits";
import { refuseTestFixture } from "@/lib/data-dir";

// Capture inbox (Today page). POST returns at once; Chief files the capture in the background.

export async function GET() {
  return NextResponse.json({ captures: listCaptures(15) });
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "form data required" }, { status: 400 });
  const text = String(form.get("text") || "");
  const refused = refuseTestFixture(text);
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  const files = (form.getAll("files") as File[]).filter((f) => f instanceof File && f.size > 0);
  const check = validateChatFiles(files);
  if (check.rejected.length) return NextResponse.json({ error: check.rejected.map((r) => r.reason).join("; ") }, { status: 400 });
  const attachments: StoredAttachment[] = [];
  for (const f of files) {
    const att = await saveUploadedFile(f);
    await extractAttachmentText(att);
    attachments.push(att);
  }
  try {
    const c = createCapture({ text, attachments, source: "today" });
    // Isolated test servers never start an agent run (CLAUDE.md: tests never trigger the agent).
    if (!process.env.E2E_FIXTURES) void processCapture(c.id);
    return NextResponse.json({ capture: c }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
