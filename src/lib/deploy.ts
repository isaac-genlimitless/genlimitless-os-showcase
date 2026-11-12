import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { MIRROR_MODE } from "./imessage";
import { staleAware } from "./deploy-stale";
import { diskInfo, gb } from "./disk";

export { diskInfo, dbBytes, neededBytes, gb } from "./disk";

// Deploys on the server (see bridge/glos-deploy). The server runs a release folder per commit
// (/opt/genlimitless-os/releases/<sha>) and `current` points at the live one. A deploy builds the
// newest GitHub main on the side, health-checks it, backs up the database, swaps `current` and
// restarts, rolling back by itself if the new version doesn't come up. On the Mac none of this exists.

const ROOT = process.env.GLOS_ROOT || "/opt/genlimitless-os";
const REPO = process.env.GITHUB_REPO;

export type DeployStatus = {
  state: "idle" | "running" | "done" | "failed" | "rolled_back";
  message: string;
  sha: string;
  at: string;
};

export function deployEnabled(): boolean {
  return MIRROR_MODE && fs.existsSync(path.join(ROOT, "current"));
}

function withBackupCause(status: DeployStatus | null): DeployStatus | null {
  if (!status || status.state !== "failed" || !status.message.startsWith("Database backup failed")) return status;
  try {
    const file = path.join(ROOT, "shared/deploy.log");
    const size = fs.statSync(file).size;
    const len = Math.min(size, 20_000);
    const fd = fs.openSync(file, "r");
    let tail = "";
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      tail = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    const lines = tail.split("\n").filter((l) => /(SqliteError|Error):.*/.test(l));
    const last = lines[lines.length - 1];
    if (!last) return status;
    const cause = last.replace(/^.*?(SqliteError|Error):\s*/, "").trim();
    const disk = diskInfo();
    const free = disk ? ` Free disk: ${gb(disk.freeBytes)} GB.` : "";
    return { ...status, message: `${status.message.replace(/\.$/, "")}: ${cause}.${free}` };
  } catch {
    return status;
  }
}

export function readDeployStatus(): DeployStatus | null {
  try {
    const raw = staleAware<DeployStatus>(JSON.parse(fs.readFileSync(path.join(ROOT, "shared/deploy-status.json"), "utf8")));
    return withBackupCause(raw);
  } catch {
    return null;
  }
}

/** Which commit is live: the release folder `current` points at ("initial" for the first hand-built one). */
export function liveRelease(): string | null {
  try {
    return path.basename(fs.realpathSync(path.join(ROOT, "current")));
  } catch {
    return null;
  }
}

// The Deploy bar polls every 5s from every open tab; asking GitHub each time spawned a `gh` process and
// a GitHub API call per poll (and ate the API rate limit). One shared answer, refreshed every 30s.
const LATEST_TTL_MS = 30_000;
let latestCache: { at: number; sha: string | null } | null = null;
let latestInFlight: Promise<string | null> | null = null;

// fresh: skip the cache (auto-merge must see a merge it just made, or it would mark it deployed early).
export function latestMainSha(opts: { fresh?: boolean } = {}): Promise<string | null> {
  if (!opts.fresh && latestCache && Date.now() - latestCache.at < LATEST_TTL_MS) return Promise.resolve(latestCache.sha);
  if (latestInFlight && !opts.fresh) return latestInFlight;
  latestInFlight = new Promise<string | null>((resolve) => {
    if (!REPO) return resolve(null);
    execFile("gh", ["api", `repos/${REPO}/commits/main`, "-q", ".sha"], { timeout: 30_000 }, (err, stdout) =>
      resolve(err ? null : stdout.trim().slice(0, 12))
    );
  }).then((sha) => {
    latestCache = { at: Date.now(), sha };
    return sha;
  }).finally(() => { latestInFlight = null; });
  return latestInFlight;
}

/** Starts glos-deploy as a transient systemd unit (so it survives the restart it causes). */
export function startDeploy(action: "deploy" | "rollback"): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(
      "sudo",
      ["-n", "/usr/bin/systemd-run", "--unit=glos-deploy", "--collect", "/usr/local/bin/glos-deploy", action],
      { timeout: 30_000 },
      (err, _out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve())
    )
  );
}
