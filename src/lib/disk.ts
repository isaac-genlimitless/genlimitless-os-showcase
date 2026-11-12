import fs from "fs";
import path from "path";
import db from "./db";
import { DATA_DIR } from "./data-dir";
import { resolveIssuesBySource, upsertOpenIssue } from "./issue-once";

const GB = 1024 ** 3;

export function diskInfo(dir: string = DATA_DIR): { freeBytes: number; totalBytes: number } | null {
  try {
    const s = fs.statfsSync(dir);
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return null;
  }
}

export function dbBytes(): number {
  try {
    return fs.statSync(path.join(DATA_DIR, "genlimitless.db")).size;
  } catch {
    return 0;
  }
}

/** Free space needed to take a safe backup: twice the database plus 1 GB. */
export function neededBytes(): number {
  return 2 * dbBytes() + GB;
}

export function gb(bytes: number): string {
  return (bytes / GB).toFixed(1);
}

/** True if an alert with this reason was already recorded in the last 24h. */
export function alertedRecently(reason: string): boolean {
  try {
    return !!db
      .prepare(`SELECT 1 FROM alerts WHERE reason=? AND created_at > datetime('now','-1 day') LIMIT 1`)
      .get(reason);
  } catch {
    return false;
  }
}

/** Hourly: raises an issue and one alert per 24h while free disk is below the backup threshold. */
export async function checkDiskHealth() {
  const disk = diskInfo();
  if (!disk) return;
  const need = neededBytes();
  const msg = "Server disk nearly full";
  if (disk.freeBytes >= need) {
    resolveIssuesBySource("backup", "disk space recovered", msg);
    return;
  }
  upsertOpenIssue("backup", msg, { freeBytes: disk.freeBytes, needBytes: need });
  if (alertedRecently("disk_low")) return;
  const { notifyOwner } = await import("./delivery");
  await notifyOwner({
    message: `Server disk is nearly full: ${gb(disk.freeBytes)} GB free, need about ${gb(need)} GB. Backups and deploys will fail until space is freed.`,
    reason: "disk_low",
  });
}
