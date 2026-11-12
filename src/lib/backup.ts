import fs from "fs";
import path from "path";
import db from "./db";
import { DATA_DIR } from "./data-dir";
import { logIssue } from "./db";
import { resolveIssuesBySource, upsertOpenIssue } from "./issue-once";
import { alertedRecently, diskInfo, gb } from "./disk";

// Guardrail added after a 2026-09-22 incident: a shell command deleted the live database while
// working in this repo, and recovery only worked because the server process happened to still
// have the file open. This makes that unnecessary going forward: a safe, consistent snapshot of
// the whole database, taken automatically, the newest 3 are kept, completely separate from the live
// file, and nothing here can ever delete/overwrite the live database — only ever read from it.

const KEEP_COUNT = 3; // keep only the newest 3 snapshots

function backupDir() {
  return path.join(DATA_DIR, "backups");
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Snapshot the live database (safe even mid-write, thanks to SQLite's own backup API — it
 *  reads a consistent view without blocking or disturbing the live connection). */
export async function backupDatabase(): Promise<{ path: string; bytes: number } | null> {
  try {
    const dir = backupDir();
    const dest = path.join(dir, `genlimitless-${todayStamp()}.db`);
    let bytes: number;
    try {
      fs.mkdirSync(dir, { recursive: true });
      await db.backup(dest);
      bytes = fs.statSync(dest).size;
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
      fs.mkdirSync(dir, { recursive: true }); // folder vanished mid-way: retry once
      await db.backup(dest);
      bytes = fs.statSync(dest).size;
    }
    pruneOldBackups();
    try {
      resolveIssuesBySource("backup", "backup succeeded again", "Database backup is failing");
    } catch {}
    return { path: dest, bytes };
  } catch (err: any) {
    try {
      const disk = diskInfo();
      upsertOpenIssue("backup", "Database backup is failing", {
        cause: err.message,
        code: err.code,
        freeBytes: disk?.freeBytes,
      });
      if (!alertedRecently("backup_failed")) {
        const { notifyOwner } = await import("./delivery");
        await notifyOwner({
          message: `Database backups are failing: ${err.message}. Free disk: ${disk ? gb(disk.freeBytes) : "unknown"} GB. Deploys are blocked until fixed.`,
          reason: "backup_failed",
        });
      }
    } catch {
      logIssue("backup", "Nightly database backup failed", err.message);
    }
    return null;
  }
}

export function pruneOldBackups(keep = KEEP_COUNT) {
  const dir = backupDir();
  const names = fs
    .readdirSync(dir)
    .filter((n) => /^genlimitless-\d{4}-\d{2}-\d{2}\.db$/.test(n))
    .sort() // ISO dates sort oldest -> newest
    .reverse(); // newest first
  for (const name of names.slice(Math.max(keep, 1))) {
    fs.unlinkSync(path.join(dir, name)); // only ever deletes its OWN backup copies beyond the newest `keep`
  }
}

export function listBackups(): { name: string; bytes: number; created_at: string }[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, bytes: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
