import { ownerOnly } from "@/lib/instance";
import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import "@/lib/agents/fixes"; // ensures fix_proposals extra columns exist
import { archivePage } from "@/lib/pages";
import { CleanupItem, isProtectedPage, recheckFileItem } from "@/lib/cleanup-scan";

export const dynamic = "force-dynamic";

type Result = { key: string; status: "archived" | "proposed" | "refused" | "skipped"; detail?: string };

// The ONLY cleanup action. Pages -> Trash (recoverable). Source/junk/route files -> ONE pending
// fix proposal that goes through the normal approval path. Nothing is unlinked here.
async function glosPOST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const reportId = Number(body?.reportId);
  const keys: string[] = Array.isArray(body?.keys) ? body.keys.map(String) : [];
  if (!Number.isInteger(reportId) || !keys.length) {
    return NextResponse.json({ ok: false, error: "reportId and keys[] required" }, { status: 400 });
  }
  const row = db.prepare(`SELECT id, status, items_json FROM cleanup_reports WHERE id=?`).get(reportId) as
    | { id: number; status: string; items_json: string }
    | undefined;
  if (!row) return NextResponse.json({ ok: false, error: "Report not found" }, { status: 404 });
  if (row.status !== "pending") return NextResponse.json({ ok: false, error: `Report is ${row.status}` }, { status: 409 });

  const items: CleanupItem[] = JSON.parse(row.items_json || "[]");
  const byKey = new Map(items.map((i) => [i.key, i]));
  const unknown = keys.filter((k) => !byKey.has(k));
  if (unknown.length) return NextResponse.json({ ok: false, error: "Keys not in this report", keys: unknown }, { status: 400 });

  const results: Result[] = [];
  const fileItems: CleanupItem[] = [];
  for (const key of [...new Set(keys)]) {
    const item = byKey.get(key)!;
    if (key.startsWith("page:")) {
      const id = Number(key.slice(5));
      if (!Number.isInteger(id) || isProtectedPage(id)) {
        results.push({ key, status: "refused", detail: "Protected page" });
        continue;
      }
      try {
        archivePage(id);
        results.push({ key, status: "archived", detail: "Moved to Trash" });
      } catch (e: any) {
        results.push({ key, status: "skipped", detail: String(e?.message || e) });
      }
    } else {
      const problem = recheckFileItem(item);
      if (problem) results.push({ key, status: "skipped", detail: problem });
      else fileItems.push(item);
    }
  }

  if (fileItems.length) {
    const files = fileItems.map((i) => i.where);
    const info = db
      .prepare(
        `INSERT INTO fix_proposals (title, diagnosis, proposed_change, files, status, kind, size, size_reasons, proposed_by)
         VALUES (?, ?, ?, ?, 'pending_approval', 'local', 'major', ?, 'cleanup')`
      )
      .run(
        `Weekly cleanup: remove ${files.length} file(s)`,
        fileItems.map((i) => `- ${i.where}: ${i.reason}`).join("\n"),
        `Remove these files (git-tracked removal):\n${files.join("\n")}`,
        JSON.stringify(files),
        "Removes files (Owner approved the cleanup selection)"
      );
    const pid = Number(info.lastInsertRowid);
    for (const i of fileItems) results.push({ key: i.key, status: "proposed", detail: `Fix proposal #${pid}` });
  }

  db.prepare(`UPDATE cleanup_reports SET status='applied', result_json=? WHERE id=?`).run(JSON.stringify(results), reportId);
  return NextResponse.json({ ok: true, results });
}

// Owner-only: 404 in a member cell (docs/multi-user.md "Member mode").
export const POST = ownerOnly(glosPOST);
