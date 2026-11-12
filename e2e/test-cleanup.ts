import fs from "fs";
import path from "path";
import { openTestDb, testFilesDir, testMeetingsDir } from "./db-handle";

/** Removes every "E2E ..." meeting (and its audio file) from the isolated test DB only. */
export function cleanupMeetings() {
  if (!process.env.E2E_START_SERVER) return;
  const db = openTestDb();
  try {
    const rows = db.prepare(`SELECT id, audio_path FROM meetings WHERE title LIKE 'E2E %'`).all() as {
      id: number;
      audio_path: string | null;
    }[];
    const del = db.prepare(`DELETE FROM meetings WHERE id = ?`);
    db.transaction(() => rows.forEach((r) => del.run(r.id)))();
    for (const r of rows) {
      if (r.audio_path) fs.rmSync(path.join(testMeetingsDir(), path.basename(r.audio_path)), { force: true });
    }
  } finally {
    db.close();
  }
}

/**
 * Removes every "E2E ..." page/folder/upload (and anything nested under them, e.g. the "Sub"
 * folder a folder_path creates) from the isolated test DB, plus their uploaded bytes.
 * No-op outside the isolated server: there the Files specs are skipped and wrote nothing, and
 * afterEach hooks still run for skipped tests.
 */
export function cleanupFilesPages() {
  if (!process.env.E2E_START_SERVER) return;
  const db = openTestDb();
  try {
    const rows = db
      .prepare(
        `WITH RECURSIVE doomed(id) AS (
           SELECT id FROM docs WHERE title LIKE 'E2E %'
           UNION SELECT d.id FROM docs d JOIN doomed ON d.parent_id = doomed.id
         )
         SELECT id, file_path FROM docs WHERE id IN (SELECT id FROM doomed)`
      )
      .all() as { id: number; file_path: string | null }[];
    for (const r of rows) {
      if (r.file_path) fs.rmSync(path.join(testFilesDir(), path.basename(r.file_path)), { force: true });
    }
    const del = db.prepare(`DELETE FROM docs WHERE id = ?`);
    db.transaction(() => rows.forEach((r) => del.run(r.id)))();
  } finally {
    db.close();
  }
}
