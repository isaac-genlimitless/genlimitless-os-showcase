import fs from "fs";
import path from "path";

// Prunes OLD pre-deploy database snapshots in <root>/backups/ (written by bridge/glos-deploy:104).
// Only regular files directly inside backups/ named pre-deploy-<UTC time>-<sha>.db are ever removed.
// The newest 3 (by the time in the name) are always kept, so the newest is never touched; snapshots
// for the current or previous release are also kept. Everything else in backups/ is ignored.
// Skips entirely while a deploy is running. Only Node built-ins at module level (db/deploy load lazily).

const OS_ROOT = process.env.GLOS_ROOT || "/opt/genlimitless-os";
const KEEP_NEWEST = 3;
const NAME_RE = /^pre-deploy-(\d{8}T\d{6}Z)-([0-9a-f]{7,40})\.db$/;

export type BackupPruneResult = {
  at: string;
  skippedReason?: string;
  kept: string[];
  removed: { name: string; bytes: number }[];
  failed: { name: string; error: string }[];
  freedBytes: number;
};
export type BackupPruneDeps = {
  logIssue: (source: string, message: string, detail?: unknown) => void;
  getState: (key: string) => string | null;
  setState: (key: string, value: string) => void;
};

function defaultDeps(): BackupPruneDeps {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dbm = require("./db");
  return { logIssue: dbm.logIssue, getState: dbm.getState, setState: dbm.setState };
}

function defaultStatusReader(): { state?: string } | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./deploy").readDeployStatus();
}

function releaseOf(link: string, releasesDir: string | null): string | null {
  try {
    const real = fs.realpathSync(link);
    return releasesDir && path.dirname(real) === releasesDir ? path.basename(real) : null;
  } catch {
    return null;
  }
}

export function pruneDeployBackups(
  root: string = OS_ROOT,
  statusReader: () => { state?: string } | null = defaultStatusReader,
  depsIn?: BackupPruneDeps
): BackupPruneResult {
  const deps = depsIn || defaultDeps();
  const res: BackupPruneResult = { at: new Date().toISOString(), kept: [], removed: [], failed: [], freedBytes: 0 };
  const finish = () => {
    try {
      deps.setState("backup_prune:last", JSON.stringify(res));
      if (res.removed.length) {
        const total = Number(deps.getState("backup_prune:total_freed")) || 0;
        deps.setState("backup_prune:total_freed", String(total + res.freedBytes));
      }
    } catch {}
    return res;
  };

  let status: { state?: string } | null = null;
  try { status = statusReader(); } catch { status = null; }
  if (status?.state === "running") { res.skippedReason = "deploy running"; return finish(); }

  let dir: string;
  try {
    dir = fs.realpathSync(path.join(root, "backups"));
    if (!fs.statSync(dir).isDirectory()) throw new Error("not a folder");
  } catch {
    res.skippedReason = "backups folder not found";
    return finish();
  }

  let releasesDir: string | null = null;
  try { releasesDir = fs.realpathSync(path.join(root, "releases")); } catch {}
  const liveShas = [releaseOf(path.join(root, "current"), releasesDir), releaseOf(path.join(root, "previous"), releasesDir)].filter(Boolean) as string[];

  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { res.skippedReason = "could not read backups folder"; return finish(); }

  const snaps: { name: string; stamp: string; sha: string; mtime: number }[] = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    try {
      const st = fs.lstatSync(path.join(dir, name));
      if (st.isFile()) snaps.push({ name, stamp: m[1], sha: m[2], mtime: st.mtimeMs });
    } catch {}
  }
  snaps.sort((a, b) => b.stamp.localeCompare(a.stamp) || b.mtime - a.mtime || (a.name < b.name ? 1 : -1));

  if (snaps.length <= KEEP_NEWEST) {
    res.kept = snaps.map((s) => s.name);
    return finish();
  }

  snaps.forEach((s, i) => {
    const forLiveRelease = liveShas.some((r) => r.startsWith(s.sha) || s.sha.startsWith(r));
    if (i < KEEP_NEWEST || forLiveRelease) { res.kept.push(s.name); return; }
    const p = path.join(dir, s.name);
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || path.dirname(fs.realpathSync(p)) !== dir) return;
      fs.unlinkSync(p);
      console.log(`[backup-prune] removed ${p} (${st.size} bytes)`);
      res.removed.push({ name: s.name, bytes: st.size });
      res.freedBytes += st.size;
    } catch (err: any) {
      res.failed.push({ name: s.name, error: String(err?.message || err) });
      try { deps.logIssue("backup-prune", `Could not remove old pre-deploy backup ${s.name}`, err?.message); } catch {}
    }
  });
  return finish();
}
