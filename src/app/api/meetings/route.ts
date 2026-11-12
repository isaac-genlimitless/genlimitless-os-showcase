import { NextRequest, NextResponse } from "next/server";
import { importRecording, listMeetings, publicMeeting, startMeeting } from "@/lib/meetings";
import { availableEngine } from "@/lib/transcribe";

export async function GET() {
  return NextResponse.json({ meetings: listMeetings(), engine: await availableEngine() });
}

// JSON: start a live recording. multipart (file): import an existing recording.
export async function POST(req: NextRequest) {
  if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "file is required" }, { status: 400 });
    if ((await availableEngine()) === "browser") {
      return NextResponse.json(
        { error: "Transcribing an uploaded recording needs a transcription engine: add OPENAI_API_KEY to .env.local, or install whisper-cpp + ffmpeg and set WHISPER_MODEL." },
        { status: 400 }
      );
    }
    const title = typeof form.get("title") === "string" ? (form.get("title") as string) : undefined;
    return NextResponse.json({ meeting: publicMeeting(await importRecording(file, title)) }, { status: 201 });
  }
  const input = await req.json().catch(() => ({}));
  const m = startMeeting({
    title: typeof input.title === "string" ? input.title : undefined,
    event_id: input.event_id,
    event_account: input.event_account,
    attendees: Array.isArray(input.attendees) ? input.attendees.map(String) : [],
    mime: typeof input.mime === "string" ? input.mime.split(";")[0] : undefined,
  });
  return NextResponse.json({ meeting: publicMeeting(m) }, { status: 201 });
}
