import cron from "node-cron";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import db from "./db";
import { DATA_DIR } from "./data-dir";
import { bumpOpenIssue } from "./issue-once";
import { getFixProposal } from "./agents/fixes";
import { deployEnabled, readDeployStatus, liveRelease, latestMainSha, startDeploy } from "./deploy";
import { autoMergeTick, type Deps, type LogRow } from "./auto-merge";

// Real wiring for src/lib/auto-merge.ts: gh, the OS database, glos-deploy. Server only.


let ready = false;
function init() {
  if (ready) return;
  db.exec(`
CREATE TABLE IF NOT EXISTS auto_merge_log (
  pr INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL,           -- held | merged | deployed | deploy_failed
  reasons TEXT,                   -- JSON array, for holds
  deploy_tries INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (pr, head_sha)
);`);
  ready = true;
}

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("gh", args, { timeout: 90_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim())
    )
  );
}

export function autoMergeKilled(): boolean {
  return process.env.AUTO_MERGE === "0" || fs.existsSync(path.join(DATA_DIR, "AUTO_MERGE_DISABLED"));
}

export function realDeps(repo: string): Deps {
  init();
  return {
    repo,
    gh,
    killed: autoMergeKilled,
    fixIsOurs: (id) => {
      const p = getFixProposal(id);
      return !!p && p.kind === "github" && p.status === "sent_to_github";
    },
    log: {
      get: (pr, sha) => db.prepare(`SELECT * FROM auto_merge_log WHERE pr=? AND head_sha=?`).get(pr, sha) as LogRow | undefined,
      put: (pr, sha, status, reasons) =>
        db.prepare(`INSERT OR REPLACE INTO auto_merge_log (pr, head_sha, status, reasons) VALUES (?, ?, ?, ?)`).run(pr, sha, status, reasons ? JSON.stringify(reasons) : null),
      awaitingDeploy: () => db.prepare(`SELECT * FROM auto_merge_log WHERE status='merged'`).all() as LogRow[],
      setStatus: (rows, status, addTry) => {
        const upd = db.prepare(`UPDATE auto_merge_log SET status=?, deploy_tries=deploy_tries+?, updated_at=datetime('now') WHERE pr=? AND head_sha=?`);
        for (const r of rows) upd.run(status, addTry ? 1 : 0, r.pr, r.head_sha);
      },
    },
    deploy: { status: readDeployStatus, live: liveRelease, latest: () => latestMainSha({ fresh: true }), start: () => startDeploy("deploy") },
    held: (pr, branch, reasons) =>
      bumpOpenIssue("auto_merge", `PR #${pr} (${branch}) was not auto-merged and needs your review: ${reasons.slice(0, 3).join("; ")}${reasons.length > 3 ? ` (+${reasons.length - 3} more)` : ""}`, { pr, reasons }),
    note: (message) => void db.prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant', ?)`).run(message),
    problem: (message, extra) => bumpOpenIssue("auto_merge", message, extra),
  };
}

export function startAutoMerge() {
  const g = globalThis as { __autoMergeStarted?: boolean; __autoMergeRunning?: boolean };
  const repo = process.env.GITHUB_REPO;
  if (g.__autoMergeStarted || !repo || !deployEnabled()) return; // server only: the Mac has nothing to deploy to
  g.__autoMergeStarted = true;
  cron.schedule("*/3 * * * *", async () => {
    if (g.__autoMergeRunning) return;
    g.__autoMergeRunning = true;
    try {
      await autoMergeTick(realDeps(repo));
    } catch (e) {
      bumpOpenIssue("auto_merge", `Auto-merge check failed: ${(e as Error).message.slice(0, 300)}`);
    } finally {
      g.__autoMergeRunning = false;
    }
  });
}
