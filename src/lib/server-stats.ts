import fs from "fs";
import os from "os";
import path from "path";
import { resolveDataDir } from "./data-dir";

// Read-only capacity snapshot for agents. Metadata only: sizes and counts, never file names
// (other than top-level folder names and user folder ids), contents, or env values.
// Nothing here writes, deletes, executes, or opens the live database (it is only stat'ed).

const MAX_ENTRIES = 50_000; // per directory walk, so a huge tree can't hang the call
const MAX_DEPTH = 12;
const MAX_MS = 4_000; // per walk time budget

export type DirSize = { name: string; bytes: number; files: number; truncated: boolean };

function walk(root: string): { bytes: number; files: number; truncated: boolean } {
  const start = Date.now();
  let bytes = 0;
  let files = 0;
  let seen = 0;
  let truncated = false;
  const stack: Array<[string, number]> = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES || Date.now() - start > MAX_MS) {
        truncated = true;
        return { bytes, files, truncated };
      }
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // never follow links
      if (e.isDirectory()) {
        if (depth + 1 > MAX_DEPTH) truncated = true;
        else stack.push([p, depth + 1]);
      } else if (e.isFile()) {
        try {
          bytes += fs.lstatSync(p).size;
          files++;
        } catch {}
      }
    }
  }
  return { bytes, files, truncated };
}

function disk(p: string) {
  try {
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { path: p, totalBytes: total, usedBytes: total - s.bfree * s.bsize, freeBytes: free };
  } catch {
    return null;
  }
}

function subdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Per-month backup snapshot sizes, from dated names genlimitless-YYYY-MM-DD.db. Sizes only. */
function backupGrowth(dataDir: string) {
  const dir = path.join(dataDir, "backups");
  const byMonth: Record<string, number> = {};
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {}
  for (const n of names) {
    const m = /^genlimitless-(\d{4}-\d{2})-\d{2}\.db$/.exec(n);
    if (!m) continue;
    try {
      const size = fs.statSync(path.join(dir, n)).size;
      byMonth[m[1]] = Math.max(byMonth[m[1]] || 0, size); // largest snapshot seen that month
    } catch {}
  }
  const months = Object.keys(byMonth).sort();
  const series = months.map((month, i) => ({
    month,
    dbBytes: byMonth[month],
    growthBytes: i === 0 ? null : byMonth[month] - byMonth[months[i - 1]],
  }));
  return series;
}

export function getServerStats(opts: { dataDir?: string; diskPath?: string } = {}) {
  const dataDir = opts.dataDir || resolveDataDir();
  const mem = process.memoryUsage();
  const cpus = os.cpus();

  const dataBreakdown: DirSize[] = subdirs(dataDir).map((name) => ({ name, ...walk(path.join(dataDir, name)) }));
  let looseBytes = 0;
  try {
    for (const e of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (e.isFile()) looseBytes += fs.lstatSync(path.join(dataDir, e.name)).size;
    }
  } catch {}

  let liveDbBytes: number | null = null;
  try {
    liveDbBytes = fs.statSync(path.join(dataDir, "genlimitless.db")).size;
  } catch {}

  // Per-user data: each folder directly under data/users (if present), by folder id.
  const usersDir = path.join(dataDir, "users");
  const perUser: DirSize[] = subdirs(usersDir).map((name) => ({ name, ...walk(path.join(usersDir, name)) }));

  return {
    generatedAt: new Date().toISOString(),
    disk: disk(opts.diskPath || "/opt") || disk(dataDir),
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    cpu: { count: cpus.length, model: cpus[0]?.model ?? null },
    loadAvg: os.loadavg(),
    process: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
    data: { looseFilesBytes: looseBytes, folders: dataBreakdown },
    database: { liveBytes: liveDbBytes, monthly: backupGrowth(dataDir) },
    perUser,
  };
}
