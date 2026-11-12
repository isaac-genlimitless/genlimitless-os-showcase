import fs from "fs";
import path from "path";

// Deletes OLD release folders under <root>/releases/. Only 12-hex-named folders directly inside
// releases/ can ever be removed; current, running, previous and the newest 3 are always kept.
// Only Node built-ins at module level so the unit test needs no database (db/deploy load lazily).

const OS_ROOT = process.env.GLOS_ROOT || "/opt/genlimitless-os";
const RELEASE_RE = /^[0-9a-f]{12}$/;
const KEEP_NEWEST = 3;

export type CleanupTrigger = "after-deploy" | "health-check";
export type CleanupResult = {
  at: string;
  trigger: CleanupTrigger;
  skippedReason?: string;
  kept: string[];
  removed: { name: string; bytes: number }[];
  failed: { name: string; error: string }[];
  freedBytes: number;
};

export type CleanupDeps = {
  logIssue: (source: string, message: string, detail?: unknown) => void;
  logIssueOnce: (source: string, message: string, detail?: unknown) => void;
  getState: (key: string) => string | null;
  setState: (key: string, value: string) => void;
};

function defaultDeps(): CleanupDeps {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dbm = require("./db");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const once = require("./issue-once");
  return { logIssue: dbm.logIssue, logIssueOnce: once.logIssueOnce, getState: dbm.getState, setState: dbm.setState };
}

function defaultStatusReader(): { state?: string } | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./deploy").readDeployStatus();
}

function dirBytes(p: string): number {
  let total = 0;
  const st = fs.lstatSync(p);
  total += st.size;
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) total += dirBytes(path.join(p, e));
  }
  return total;
}

function save(deps: CleanupDeps, res: CleanupResult) {
  try {
    deps.setState("release_cleanup:last", JSON.stringify(res));
    if (res.removed.length) {
      let hist: CleanupResult[] = [];
      try {
        hist = JSON.parse(deps.getState("release_cleanup:history") || "[]");
      } catch {
        hist = [];
      }
      hist.push(res);
      deps.setState("release_cleanup:history", JSON.stringify(hist.slice(-20)));
      const total = Number(deps.getState("release_cleanup:total_freed")) || 0;
      deps.setState("release_cleanup:total_freed", String(total + res.freedBytes));
    }
  } catch (err: any) {
    try { deps.logIssue("release-cleanup", "Could not save cleanup result", err?.message); } catch {}
  }
}

export function runReleaseCleanup(
  trigger: CleanupTrigger,
  root: string = OS_ROOT,
  cwd: string = process.cwd(),
  statusReader: () => { state?: string } | null = defaultStatusReader,
  depsIn?: CleanupDeps
): CleanupResult {
  const deps = depsIn || defaultDeps();
  const res: CleanupResult = { at: new Date().toISOString(), trigger, kept: [], removed: [], failed: [], freedBytes: 0 };
  const skip = (reason: string) => {
    res.skippedReason = reason;
    save(deps, res);
    return res;
  };

  let releasesDir: string;
  try {
    releasesDir = fs.realpathSync(path.join(root, "releases"));
    if (!fs.statSync(releasesDir).isDirectory()) return skip("releases folder not found");
  } catch {
    return skip("releases folder not found");
  }

  let status: { state?: string } | null = null;
  try { status = statusReader(); } catch { status = null; }
  if (status?.state === "running") return skip("deploy running");

  let current: string;
  try {
    current = fs.realpathSync(path.join(root, "current"));
    if (!fs.statSync(current).isDirectory() || path.dirname(current) !== releasesDir) throw new Error("current is not inside releases/");
  } catch (err: any) {
    try {
      deps.logIssueOnce("release-cleanup", "Old-release cleanup skipped: could not determine the current release", { root, error: err?.message });
    } catch {}
    return skip("could not determine the current release");
  }

  const protectedNames = new Set<string>([path.basename(current)]);
  const rel = path.relative(releasesDir, cwd);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) protectedNames.add(rel.split(path.sep)[0]);
  try {
    const prev = fs.realpathSync(path.join(root, "previous"));
    if (path.dirname(prev) === releasesDir) protectedNames.add(path.basename(prev));
  } catch {}

  let entries: string[] = [];
  try { entries = fs.readdirSync(releasesDir); } catch { return skip("could not read releases folder"); }

  const hashed: { name: string; mtime: number }[] = [];
  for (const name of entries) {
    if (!RELEASE_RE.test(name)) continue;
    try {
      const st = fs.lstatSync(path.join(releasesDir, name));
      if (st.isDirectory()) hashed.push({ name, mtime: st.mtimeMs });
    } catch {}
  }
  hashed.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : 1));
  for (const h of hashed.slice(0, KEEP_NEWEST)) protectedNames.add(h.name);

  for (const name of entries) {
    if (protectedNames.has(name)) {
      res.kept.push(name);
      continue;
    }
    if (!RELEASE_RE.test(name)) continue;
    const p = path.join(releasesDir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      const real = fs.realpathSync(p);
      if (path.resolve(p) !== real || path.dirname(real) !== releasesDir || !real.startsWith(releasesDir + path.sep)) continue;
      const dataPath = path.join(real, "data");
      let dataEntry: fs.Stats | null = null;
      try { dataEntry = fs.lstatSync(dataPath); } catch {}
      if (dataEntry && !dataEntry.isSymbolicLink()) continue;

      const bytes = dirBytes(real);
      try {
        fs.rmSync(real, { recursive: true, force: true });
        console.log(`[release-cleanup] removed ${real} (${bytes} bytes) trigger=${trigger}`);
        res.removed.push({ name, bytes });
        res.freedBytes += bytes;
      } catch (err: any) {
        res.failed.push({ name, error: String(err?.message || err) });
        try { deps.logIssue("release-cleanup", `Could not remove old release ${name}`, err?.message); } catch {}
      }
    } catch (err: any) {
      res.failed.push({ name, error: String(err?.message || err) });
    }
  }

  save(deps, res);
  return res;
}

export function getCleanupSummary(): { last: CleanupResult | null; history: CleanupResult[]; totalFreedBytes: number } {
  try {
    const { getState } = defaultDeps();
    const parse = <T,>(k: string, d: T): T => {
      try {
        const v = getState(k);
        return v ? (JSON.parse(v) as T) : d;
      } catch {
        return d;
      }
    };
    return {
      last: parse<CleanupResult | null>("release_cleanup:last", null),
      history: parse<CleanupResult[]>("release_cleanup:history", []),
      totalFreedBytes: Number(getState("release_cleanup:total_freed")) || 0,
    };
  } catch {
    return { last: null, history: [], totalFreedBytes: 0 };
  }
}
