import fs from "fs";
import path from "path";
import { execFile } from "child_process";

// Read-only listing of the big folders under the OS root, for the Settings "Disk usage" card and the
// disk_usage agent tool. Metadata only: readdir, lstat, realpath and one fixed `du` per folder.
// Never opens file contents, never writes, never deletes. Runs as the app user (glos), which owns
// these folders; agents' own file tools stay blocked from backups/ by agent-lock.ts on purpose.

const OS_ROOT = process.env.GLOS_ROOT || "/opt/genlimitless-os";
export const DISK_USAGE_FOLDERS = ["backups", "releases", "work", "mirror", "shared/data/backups", ".cache", ".npm"] as const;
const MAX_ENTRIES = 300;
const RELEASE_RE = /^[0-9a-f]{12}$/;
const PREDEPLOY_RE = /^pre-deploy-(\d{8}T\d{6}Z)-([0-9a-f]+)\.db$/;

export type DiskEntry = { name: string; type: "dir" | "file" | "link" | "other"; bytes: number | null; modified: string | null; tags: string[] };
export type DiskFolder = { folder: string; path: string; exists: boolean; error?: string; totalBytes: number | null; entryCount: number; truncated: boolean; entries: DiskEntry[] };
export type DiskUsage = { at: string; root: string; runningRelease: string | null; currentRelease: string | null; previousRelease: string | null; folders: DiskFolder[] };

function duMap(dir: string): Promise<Map<string, number>> {
  return new Promise((resolve) => {
    execFile("du", ["-k", "-a", "-x", "--max-depth=1", dir], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => {
      const m = new Map<string, number>();
      for (const line of String(stdout || "").split("\n")) {
        const i = line.indexOf("\t");
        if (i < 0) continue;
        const kb = Number(line.slice(0, i));
        if (Number.isFinite(kb)) m.set(line.slice(i + 1), kb * 1024);
      }
      resolve(m); // partial output (e.g. one unreadable subfolder) still counts
    });
  });
}

function releaseOf(link: string, releasesDir: string | null): string | null {
  try {
    const real = fs.realpathSync(link);
    return releasesDir && path.dirname(real) === releasesDir ? path.basename(real) : null;
  } catch {
    return null;
  }
}

type Ctx = { running: string | null; current: string | null; previous: string | null };

function tag(folder: string, entries: DiskEntry[], ctx: Ctx) {
  // entries arrive sorted newest-modified first
  if (folder === "releases") {
    let n = 0;
    for (const e of entries) {
      if (e.name === ctx.running) e.tags.push("running");
      if (e.name === ctx.current) e.tags.push("current");
      if (e.name === ctx.previous) e.tags.push("previous");
      if (RELEASE_RE.test(e.name) && e.type === "dir" && n++ < 3) e.tags.push("newest 3 (auto-cleanup keeps)");
      if (RELEASE_RE.test(e.name) && e.type === "dir" && !e.tags.length) e.tags.push("old release (auto-cleanup removes)");
    }
  }
  if (folder === "backups") {
    let first = true;
    for (const e of entries) {
      const m = PREDEPLOY_RE.exec(e.name);
      if (!m) continue;
      if (first) { e.tags.push("newest pre-deploy backup"); first = false; }
      const sha = m[2];
      const same = (r: string | null) => !!r && (r.startsWith(sha) || sha.startsWith(r));
      if (same(ctx.current)) e.tags.push("taken deploying current release");
      if (same(ctx.previous)) e.tags.push("taken deploying previous release");
    }
  }
}

async function listFolder(root: string, folder: string, ctx: Ctx): Promise<DiskFolder> {
  const p = path.join(root, folder);
  const out: DiskFolder = { folder, path: p, exists: false, totalBytes: null, entryCount: 0, truncated: false, entries: [] };
  let names: string[];
  try {
    if (!fs.statSync(p).isDirectory()) { out.error = "not a folder"; return out; }
    out.exists = true;
    names = fs.readdirSync(p);
  } catch (e: any) {
    if (e?.code !== "ENOENT") out.error = String(e?.code || e?.message || e);
    return out;
  }
  const sizes = await duMap(p);
  out.totalBytes = sizes.get(p) ?? null;
  const entries: DiskEntry[] = names.map((name) => {
    const full = path.join(p, name);
    let type: DiskEntry["type"] = "other";
    let modified: string | null = null;
    try {
      const st = fs.lstatSync(full);
      type = st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
      modified = st.mtime.toISOString();
    } catch {}
    return { name, type, bytes: sizes.get(full) ?? null, modified, tags: [] };
  });
  entries.sort((a, b) => (b.modified || "").localeCompare(a.modified || "") || a.name.localeCompare(b.name));
  tag(folder, entries, ctx);
  out.entryCount = entries.length;
  out.truncated = entries.length > MAX_ENTRIES;
  out.entries = entries.slice(0, MAX_ENTRIES);
  return out;
}

export async function listDiskUsage(root: string = OS_ROOT, cwd: string = process.cwd()): Promise<DiskUsage> {
  let releasesDir: string | null = null;
  try { releasesDir = fs.realpathSync(path.join(root, "releases")); } catch {}
  let running: string | null = null;
  if (releasesDir) {
    const rel = path.relative(releasesDir, cwd);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) running = rel.split(path.sep)[0];
  }
  const ctx: Ctx = { running, current: releaseOf(path.join(root, "current"), releasesDir), previous: releaseOf(path.join(root, "previous"), releasesDir) };
  const folders = await Promise.all(DISK_USAGE_FOLDERS.map((f) => listFolder(root, f, ctx)));
  return { at: new Date().toISOString(), root, runningRelease: ctx.running, currentRelease: ctx.current, previousRelease: ctx.previous, folders };
}

let cache: { at: number; value: DiskUsage } | null = null;
let inflight: Promise<DiskUsage> | null = null;

/** Cached 5 minutes (du over releases/ is slow). fresh=true bypasses the cache. */
export function getDiskUsage(opts: { fresh?: boolean } = {}): Promise<DiskUsage> {
  if (!opts.fresh && cache && Date.now() - cache.at < 5 * 60 * 1000) return Promise.resolve(cache.value);
  if (inflight) return inflight;
  inflight = listDiskUsage()
    .then((value) => { cache = { at: Date.now(), value }; return value; })
    .finally(() => { inflight = null; });
  return inflight;
}
