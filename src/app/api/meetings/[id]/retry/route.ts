import { NextRequest, NextResponse } from "next/server";
import db, { logIssue } from "@/lib/db";
import { getMeeting, processMeeting, publicMeeting } from "@/lib/meetings";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const m = getMeeting(id);
  if (!m) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (m.status === "recording" || m.status === "processing") return NextResponse.json({ error: `Meeting is still ${m.status}` }, { status: 409 });
  processMeeting(id).catch((err) => {
    db.prepare(`UPDATE meetings SET status='failed', error=? WHERE id=?`).run(String(err.message || err), id);
    logIssue("meetings", `Retrying meeting #${id} failed`, err.message);
  });
  return NextResponse.json({ meeting: publicMeeting({ ...m, status: "processing" }) });
}
