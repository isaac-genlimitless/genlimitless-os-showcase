import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { DATA_DIR } from "./data-dir";

// One-time startup recovery for page 399 (docs row). Its sections 1-3 were emptied by an
// in-place overwrite and there is no page history. Earlier bodies may survive in undo_actions,
// spellfix_versions and the dated DB backups. This copies each one into a NEW page so they can be
// read with get_page. It NEVER writes to docs row 399, deletes nothing, and is idempotent
// (does nothing once the recovery page exists). Raw SQL only, so it has no import cycle with db.ts.

export const RECOVERY_TITLE = "Recovered versions of page 399";
const PAGE_ID = 399;

function hasTable(db: Db, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

// Keep only the sections 1-3 portion: cut at the first heading that starts section 4 or the kit.
function sectionsOneToThree(body: string): string {
  const m = /^#{1,6}\s*(?:4[.):\s]|section\s*4|planning session kit)/im.exec(body);
  return m ? body.slice(0, m.index).trimEnd() : body;
}

function fence(text: string): string {
  return "\n" + text + "\n";
}

const FOLLOWUP_SINCE = "2026-10-25";

// Follow-up recovery: appends later snapshots of page 399 (undo log, dated backups, version table
// if present) to the recovery page. Writes ONLY to the recovery page, never docs 399, deletes nothing.
// Idempotent: a snapshot whose header is already in the recovery page is skipped.
export async function recoverPage399Followup(
  db: Db,
  opts: { backupsDir?: string; skipBackup?: boolean } = {}
): Promise<{ appended: number }> {
  if (!db.prepare(`SELECT 1 FROM docs WHERE title = ?`).get(RECOVERY_TITLE)) return { appended: 0 };

  let justMade: string | null = null;
  if (!opts.skipBackup) {
    const { backupDatabase } = await import("./backup");
    const res = await backupDatabase();
    justMade = res?.path ? path.basename(res.path) : null;
  }

  const snaps: { header: string; body: string }[] = [];

  if (hasTable(db, "undo_actions")) {
    const rows = db
      .prepare(
        `SELECT id, tool, agent_slug, created_at, state, before_json FROM undo_actions
         WHERE entity='page' AND entity_id=? AND created_at >= ? ORDER BY id`
      )
      .all(String(PAGE_ID), FOLLOWUP_SINCE) as { id: number; tool: string; agent_slug: string | null; created_at: string; state: string; before_json: string | null }[];
    for (const r of rows) {
      try {
        const b = r.before_json ? JSON.parse(r.before_json)?.body : null;
        if (typeof b === "string" && b.trim()) {
          snaps.push({
            header: `## Undo log #${r.id}`,
            body: `: ${r.tool} by ${r.agent_slug ?? "unknown"} at ${r.created_at} (state: ${r.state}) (full body)\n${fence(b)}`,
          });
        }
      } catch {
        /* unparseable snapshot: skip */
      }
    }
  }

  for (const t of ["page_versions", "doc_versions", "docs_versions"]) {
    if (!hasTable(db, t)) continue;
    try {
      const cols2 = new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
      const idCol = cols2.has("page_id") ? "page_id" : cols2.has("doc_id") ? "doc_id" : null;
      const bodyCol = cols2.has("body") ? "body" : cols2.has("before_body") ? "before_body" : null;
      if (!idCol || !bodyCol || !cols2.has("id")) continue;
      const rows = db.prepare(`SELECT id, ${bodyCol} AS body FROM ${t} WHERE ${idCol}=? ORDER BY id`).all(PAGE_ID) as { id: number; body: string }[];
      for (const r of rows) {
        if (r.body?.trim()) snaps.push({ header: `## Version ${t} #${r.id}`, body: ` (full body)\n${fence(r.body)}` });
      }
    } catch {
      /* skip */
    }
  }

  const dir = opts.backupsDir ?? path.join(DATA_DIR, "backups");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".db") && f !== justMade).sort();
  } catch {
    /* no backups dir */
  }
  for (const f of files) {
    const m = /(\d{4}-\d{2}-\d{2})/.exec(f);
    let date = m?.[1] ?? "";
    if (!date) {
      try {
        date = fs.statSync(path.join(dir, f)).mtime.toISOString().slice(0, 10);
      } catch {
        continue;
      }
    }
    if (date <= FOLLOWUP_SINCE) continue;
    let bdb: Db | null = null;
    try {
      bdb = new Database(path.join(dir, f), { readonly: true, fileMustExist: true });
      if (!hasTable(bdb, "docs")) continue;
      const row = bdb.prepare(`SELECT body, updated_at FROM docs WHERE id=?`).get(PAGE_ID) as { body: string; updated_at: string } | undefined;
      if (!row || !row.body?.trim()) continue;
      snaps.push({ header: `## Backup ${f}`, body: ` (page updated ${row.updated_at}) (full body)\n${fence(row.body)}` });
    } catch {
      /* unreadable backup: skip */
    } finally {
      try {
        bdb?.close();
      } catch {}
    }
  }

  let appended = 0;
  const tx = db.transaction(() => {
    const cur = db.prepare(`SELECT id, body FROM docs WHERE title = ?`).get(RECOVERY_TITLE) as { id: number; body: string } | undefined;
    if (!cur) return;
    let body = cur.body ?? "";
    for (const s of snaps) {
      // Header must match as a whole token so "#1" does not match "#12".
      const esc = s.header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(esc + "(?![0-9A-Za-z._-])").test(body)) continue;
      body += `\n\n---\n\n${s.header}${s.body}`;
      appended++;
    }
    if (appended) db.prepare(`UPDATE docs SET body = ? WHERE id = ?`).run(body, cur.id);
  });
  tx();
  return { appended };
}

export type RecoverResult ={ created: boolean; pageId?: number; snapshots: number };

export async function recoverPage399(
  db: Db,
  opts: { backupsDir?: string; skipBackup?: boolean } = {}
): Promise<RecoverResult> {
  if (db.prepare(`SELECT 1 FROM docs WHERE title = ?`).get(RECOVERY_TITLE)) {
    return { created: false, snapshots: 0 };
  }

  if (!opts.skipBackup) {
    const { backupDatabase } = await import("./backup");
    await backupDatabase();
  }
  // Re-check after the await in case another run got there first.
  if (db.prepare(`SELECT 1 FROM docs WHERE title = ?`).get(RECOVERY_TITLE)) {
    return { created: false, snapshots: 0 };
  }

  const sections: string[] = [];

  if (hasTable(db, "undo_actions")) {
    const rows = db
      .prepare(`SELECT id, tool, agent_slug, created_at, state, before_json FROM undo_actions WHERE entity='page' AND entity_id=? ORDER BY id`)
      .all(String(PAGE_ID)) as { id: number; tool: string; agent_slug: string | null; created_at: string; state: string; before_json: string | null }[];
    for (const r of rows) {
      let body: string | null = null;
      try {
        const b = r.before_json ? JSON.parse(r.before_json)?.body : null;
        if (typeof b === "string" && b.trim()) body = b;
      } catch {
        /* unparseable snapshot: skip */
      }
      if (body == null) continue;
      sections.push(
        `## Undo log #${r.id}: ${r.tool} by ${r.agent_slug ?? "unknown"} at ${r.created_at} (state: ${r.state})\n${fence(body)}`
      );
    }
  }

  if (hasTable(db, "spellfix_versions")) {
    const rows = db
      .prepare(`SELECT id, run_key, created_at, before_body FROM spellfix_versions WHERE page_id=? ORDER BY id`)
      .all(PAGE_ID) as { id: number; run_key: string; created_at: string; before_body: string }[];
    for (const r of rows) {
      if (!r.before_body?.trim()) continue;
      sections.push(`## Spellfix version #${r.id} (run ${r.run_key}) at ${r.created_at}\n${fence(r.before_body)}`);
    }
  }

  const dir = opts.backupsDir ?? path.join(DATA_DIR, "backups");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".db")).sort();
  } catch {
    /* no backups dir */
  }
  for (const f of files) {
    let bdb: Db | null = null;
    try {
      bdb = new Database(path.join(dir, f), { readonly: true, fileMustExist: true });
      if (!hasTable(bdb, "docs")) continue;
      const row = bdb.prepare(`SELECT body, updated_at FROM docs WHERE id=?`).get(PAGE_ID) as { body: string; updated_at: string } | undefined;
      if (!row || !row.body?.trim()) continue;
      sections.push(`## Backup ${f} (page updated ${row.updated_at}), sections 1-3 portion\n${fence(sectionsOneToThree(row.body))}`);
    } catch {
      /* unreadable backup: skip */
    } finally {
      try {
        bdb?.close();
      } catch {}
    }
  }

  const cols = new Set((db.prepare(`PRAGMA table_info(docs)`).all() as { name: string }[]).map((c) => c.name));
  let parent: number | null = null;
  if (cols.has("parent_id")) {
    const p = db.prepare(`SELECT parent_id FROM docs WHERE id=?`).get(PAGE_ID) as { parent_id: number | null } | undefined;
    parent = p?.parent_id ?? null;
  }

  const intro = sections.length
    ? `Earlier saved versions of page ${PAGE_ID}, copied automatically. Page ${PAGE_ID} itself was not touched.\n\n`
    : `No earlier saved versions of page ${PAGE_ID} were found in the undo log, spellfix versions or backups.\n\n`;
  const body = intro + sections.join("\n\n---\n\n");

  const fields = ["title", "body", "category", "created_by"];
  const values: unknown[] = [RECOVERY_TITLE, body, "general", "agent"];
  if (cols.has("parent_id")) {
    fields.push("parent_id");
    values.push(parent);
  }
  const r = db.prepare(`INSERT INTO docs (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`).run(...values);
  return { created: true, pageId: Number(r.lastInsertRowid), snapshots: sections.length };
}
