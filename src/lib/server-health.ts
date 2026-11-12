import os from "os";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { DATA_DIR } from "./data-dir";
import { getCleanupSummary } from "./release-cleanup";
import { pctOf, statusFor, worstOf, HealthStatus } from "./server-health-core";

const OS_ROOT = "/opt/genlimitless-os";
const RELEASES_DIR = "/opt/genlimitless-os/releases";
const DISK_PATH = "/";

export function memory() {
  const total = os.totalmem();
  let available = os.freemem();
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    if (m) available = Number(m[1]) * 1024;
  } catch {}
  const used = Math.max(0, total - available);
  const pct = pctOf(used, total);
  return { total, used, free: total - used, pct, status: statusFor(pct) as HealthStatus };
}

function dfFallback(): Promise<{ total: number; used: number; free: number }> {
  return new Promise((resolve, reject) => {
    execFile("df", ["-kP", DISK_PATH], { timeout: 10000 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      const lines = String(stdout).trim().split("\n");
      const parts = lines[lines.length - 1].trim().split(/\s+/);
      const total = Number(parts[1]) * 1024;
      const used = Number(parts[2]) * 1024;
      const free = Number(parts[3]) * 1024;
      if (![total, used, free].every(Number.isFinite)) return reject(new Error("could not parse df"));
      resolve({ total, used, free });
    });
  });
}

export async function disk() {
  let t: { total: number; used: number; free: number };
  try {
    const s = (fs as any).statfsSync(DISK_PATH);
    const bsize = Number(s.bsize);
    t = {
      total: Number(s.blocks) * bsize,
      free: Number(s.bavail) * bsize,
      used: (Number(s.blocks) - Number(s.bfree)) * bsize,
    };
  } catch {
    t = await dfFallback();
  }
  const pct = pctOf(t.used, t.used + t.free);
  return { ...t, pct, status: statusFor(pct) as HealthStatus };
}

export function cpu() {
  const load = os.loadavg();
  const cores = os.cpus().length || 1;
  const pct = Math.round((load[0] / cores) * 1000) / 10;
  return { load1: load[0], load5: load[1], load15: load[2], cores, pct, status: statusFor(pct) as HealthStatus };
}

type Du = { total: number; children: { path: string; bytes: number }[] } | null;

function du(dir: string): Promise<Du> {
  return new Promise((resolve) => {
    execFile("du", ["-k", "-x", "--max-depth=1", dir], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => {
      const out = String(stdout || "").trim();
      if (!out) return resolve(null);
      let total: number | null = null;
      const children: { path: string; bytes: number }[] = [];
      for (const line of out.split("\n")) {
        const i = line.indexOf("\t");
        if (i < 0) continue;
        const kb = Number(line.slice(0, i));
        const p = line.slice(i + 1);
        if (!Number.isFinite(kb)) continue;
        if (p === dir) total = kb * 1024;
        else children.push({ path: p, bytes: kb * 1024 });
      }
      if (total == null) return resolve(null);
      resolve({ total, children });
    });
  });
}

type Sizes = {
  osRoot: number | null;
  releases: number | null;
  data: number | null;
  topFolders: { path: string; bytes: number }[];
  releaseChildren: { path: string; bytes: number }[];
  dataChildren: { path: string; bytes: number }[];
};

let sizesCache: { at: number; value: Sizes } | null = null;
let sizesInflight: Promise<Sizes> | null = null;

export function sizes(): Promise<Sizes> {
  if (sizesCache && Date.now() - sizesCache.at < 5 * 60 * 1000) return Promise.resolve(sizesCache.value);
  if (sizesInflight) return sizesInflight;
  sizesInflight = (async () => {
    try {
      const [a, b, c] = await Promise.all([du(OS_ROOT), du(RELEASES_DIR), du(DATA_DIR)]);
      const map = new Map<string, number>();
      for (const d of [a, b, c]) for (const ch of d?.children || []) map.set(ch.path, ch.bytes);
      const topFolders = [...map.entries()]
        .map(([p, bytes]) => ({ path: p, bytes }))
        .sort((x, y) => y.bytes - x.bytes)
        .slice(0, 12);
      const value: Sizes = {
        osRoot: a?.total ?? null,
        releases: b?.total ?? null,
        data: c?.total ?? null,
        topFolders,
        releaseChildren: b?.children || [],
        dataChildren: c?.children || [],
      };
      sizesCache = { at: Date.now(), value };
      return value;
    } finally {
      sizesInflight = null;
    }
  })();
  return sizesInflight;
}

function gb(b: number) {
  return (b / 1024 ** 3).toFixed(1);
}

function hints(s: Sizes, diskStatus: HealthStatus): string[] {
  const out: string[] = [];
  const cwd = process.cwd();
  const current = cwd.startsWith(RELEASES_DIR + path.sep) ? cwd.slice(RELEASES_DIR.length + 1).split(path.sep)[0] : null;
  const older = s.releaseChildren.filter((c) => path.basename(c.path) !== current);
  if (older.length > 3) {
    const sum = older.reduce((n, c) => n + c.bytes, 0);
    out.push(`${older.length} older releases use ${gb(sum)} GB. Old releases are removed automatically (the running one, the previous one and the newest 3 are always kept).`);
  }
  const backups = s.dataChildren.find((c) => path.basename(c.path) === "backups");
  if (backups && backups.bytes > 1024 ** 3) out.push(`Database backups use ${gb(backups.bytes)} GB.`);
  if (diskStatus === "red" && s.topFolders.length) {
    out.push(`The biggest folder is ${s.topFolders[0].path} (${gb(s.topFolders[0].bytes)} GB).`);
  }
  return out;
}

export async function getServerHealth() {
  const [mem, dsk, sz] = [memory(), await disk(), await sizes()];
  const c = cpu();
  const m = process.memoryUsage();
  const { releaseChildren, dataChildren, ...publicSizes } = sz;
  return {
    at: new Date().toISOString(),
    overall: worstOf([mem.status, dsk.status, c.status]),
    memory: mem,
    disk: dsk,
    cpu: c,
    uptime: { serverSeconds: os.uptime(), processSeconds: Math.round(process.uptime()) },
    nodeProcess: {
      pid: process.pid,
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external,
      rssPctOfRam: pctOf(m.rss, mem.total),
    },
    sizes: publicSizes,
    hints: hints(sz, dsk.status),
    releaseCleanup: getCleanupSummary(),
    thresholds: { yellowAbove: 75, redAbove: 90 },
  };
}

export async function getQuickHealth() {
  return { memory: memory(), disk: await disk() };
}
