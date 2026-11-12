import { NextResponse } from "next/server";
import { backupDatabase, listBackups } from "@/lib/backup";

export async function GET() {
  return NextResponse.json({ backups: listBackups() });
}

// Take one right now (e.g. before an approve/merge/risky change).
export async function POST() {
  const result = await backupDatabase();
  return result
    ? NextResponse.json({ ok: true, ...result })
    : NextResponse.json({ ok: false, error: "Backup failed — check Settings for the logged issue." }, { status: 500 });
}
