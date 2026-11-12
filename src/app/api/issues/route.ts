import { ownerOnly } from "@/lib/instance";
import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";

async function glosGET() {
  const issues = db
    .prepare(`SELECT * FROM issues WHERE status = 'open' ORDER BY created_at DESC LIMIT 500`)
    .all();
  return NextResponse.json({ issues });
}

async function glosPATCH(req: NextRequest) {
  const { id, ids, all } = await req.json();

  if (all === true) {
    db.prepare(`UPDATE issues SET status='resolved', resolved_at=datetime('now') WHERE status='open'`).run();
    return NextResponse.json({ ok: true });
  }

  const targetIds: number[] = Array.isArray(ids) && ids.length > 0 ? ids : id != null ? [id] : [];
  if (targetIds.length === 0) {
    return NextResponse.json({ error: "No id(s) provided" }, { status: 400 });
  }

  const stmt = db.prepare(
    `UPDATE issues SET status='resolved', resolved_at=datetime('now') WHERE id=? AND status='open'`
  );
  const resolveMany = db.transaction((idList: number[]) => {
    for (const targetId of idList) stmt.run(targetId);
  });
  resolveMany(targetIds);

  return NextResponse.json({ ok: true, count: targetIds.length });
}

// Owner-only: 404 in a member cell (docs/multi-user.md "Member mode").
export const GET = ownerOnly(glosGET);
export const PATCH = ownerOnly(glosPATCH);
