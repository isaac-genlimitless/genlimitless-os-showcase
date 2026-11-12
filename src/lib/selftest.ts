import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import db, { logIssue } from "./db";
import { notifyOwner } from "./delivery";
import { logIssueOnce } from "./issue-once";
import { resolveReleaseDir } from "./release-dir";

import { DATA_DIR } from "./data-dir";
import { internalToken, tokenFingerprint } from "./auth/policy";
import { e2eBaseCandidates, explainTokenRejection } from "./selftest-target";
const REPORT = path.join(DATA_DIR, "e2e-last-run.json");
const SOURCE = "selftest:e2e";

export type E2EFailure = { title: string; file?: string; error: string; snippet?: string; stack?: string };
export type E2EResult = { ok: boolean; passed: number; failed: string[]; failures: E2EFailure[]; output: string; releaseId?: string };

// Removes ANSI colour codes and caps length.
const strip = (s: any, max: number) => String(s ?? "").replace(/\[[0-9;]*m/g, "").slice(0, max);

export function failedTitles(reportPath: string = REPORT): { passed: number; failed: string[]; failures: E2EFailure[] } {
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const failed: string[] = [];
    const failures: E2EFailure[] = [];
    let passed = 0;
    const walk = (suite: any, prefix: string[]) => {
      for (const s of suite.suites || []) walk(s, [...prefix, s.title]);
      for (const spec of suite.specs || []) {
        if (spec.ok) {
          passed++;
          continue;
        }
        const title = [...prefix, spec.title].filter(Boolean).join(" › ");
        failed.push(title);
        if (failures.length >= 15) continue;
        for (const t of spec.tests || []) {
          const result = t.results?.find((r: any) => r.error || r.errors?.length);
          const err = result ? result.error || result.errors[0] : null;
          if (err) {
            failures.push({ title, file: spec.file, error: strip(err.message, 1500), snippet: strip(err.snippet, 1200), stack: strip(err.stack, 1200) });
          } else {
            failures.push({ title, file: spec.file, error: `status: ${t.status}` });
          }
          break;
        }
      }
    };
    walk(report, []);
    return { passed, failed, failures };
  } catch {
    return { passed: 0, failed: ["could not read test report"], failures: [] };
  }
}

// Playwright's browser lives in $HOME/.cache/ms-playwright (HOME=/opt/genlimitless-os), outside the release folders, so it survives deploys. `playwright install chromium` is idempotent (a no-op when the matching build is present) and re-downloads automatically if the browser is missing or @playwright/test was upgraded. Non-fatal: if it fails, the tests run and report the launch error as before; retried on the next run.
let browserReady: Promise<void> | null = null;
function ensureBrowser(): Promise<void> {
  if (!browserReady) {
    browserReady = new Promise<void>((resolve) => {
      execFile("npx", ["playwright", "install", "chromium"], { cwd: process.cwd(), env: process.env, timeout: 10 * 60_000, maxBuffer: 5 * 1024 * 1024 }, (err) => {
        if (err) browserReady = null; // try again next run
        resolve();
      });
    });
  }
  return browserReady;
}

/** Pure: pull missing shared-library names out of a browser launch error. */
export function parseMissingLibs(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text || "").matchAll(/error while loading shared libraries: (\S+?):/g)) out.add(m[1]);
  if (/Host system is missing dependencies/i.test(String(text || ""))) out.add("host dependencies (run playwright install-deps)");
  return [...out];
}

/** Launch headless chromium in a child node process; log/resolve a 'selftest:browser' issue accordingly. */
export async function checkBrowserLaunch(): Promise<{ ok: boolean; missingLibs: string[]; error?: string }> {
  const script =
    "const {chromium}=require('@playwright/test');(async()=>{const b=await chromium.launch({headless:true});await b.close();})().catch(e=>{console.error(String(e&&e.message||e));process.exit(1)})";
  return new Promise((resolve) => {
    execFile(process.execPath, ["-e", script], { cwd: process.cwd(), timeout: 60_000 }, (err, _stdout, stderr) => {
      if (!err) {
        try {
          db.prepare(`UPDATE issues SET status='resolved', resolved_at=datetime('now') WHERE source='selftest:browser' AND status='open'`).run();
        } catch {}
        resolve({ ok: true, missingLibs: [] });
        return;
      }
      const text = String(stderr || (err as Error).message || "");
      const missingLibs = parseMissingLibs(text);
      const error = text.slice(0, 1500);
      try {
        logIssueOnce(
          "selftest:browser",
          `Headless test browser cannot launch. Missing system libraries: ${missingLibs.length ? missingLibs.join(", ") : "unknown"}. Fix: on the server run "sudo npx playwright install-deps chromium", then re-run run_ui_tests.`,
          { missingLibs, error }
        );
      } catch {}
      resolve({ ok: false, missingLibs, error });
    });
  });
}

/** Pure-ish: if the report file is missing or older than startedMs, the run didn't execute; return an error result, else null. */
export function staleReportResult(reportPath: string, startedMs: number, err: any, stderr: string, stdout: string = ""): E2EResult | null {
  let mtime = 0;
  try {
    mtime = fs.statSync(reportPath).mtimeMs;
  } catch {}
  if (mtime >= startedMs) return null;
  const firstLine = String(err?.message || "").split("\n")[0].trim();
  const lastErrLine = String(stderr || "").split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
  const how = err?.killed ? "timed out/killed" : "exit " + (err?.code ?? "?");
  const reason = (lastErrLine || firstLine || "report is stale").slice(0, 160);
  const title = "test run did not execute: " + how + " - " + reason;
  const outTail = String(stdout || "").slice(-1200);
  const errTail = String(stderr || "").slice(-1200);
  return {
    ok: false,
    passed: 0,
    failed: [title],
    failures: [
      {
        title,
        error:
          `${err?.message || "no error"}\n--- stdout (tail) ---\n${outTail}\n--- stderr (tail) ---\n${errTail}` +
          `\nexit code: ${err?.code ?? "n/a"}, signal: ${err?.signal ?? "none"}, killed(timeout/maxBuffer): ${!!err?.killed}, elapsed: ${Math.round((Date.now() - startedMs) / 1000)}s`,
      },
    ],
    output: `${String(stdout || "")}\n${String(stderr || "")}`.slice(-2000),
  };
}

/** Run the Playwright click-through tests against this running server (optionally only some spec files). */
export async function runE2E(specFiles: string[] = [], targetRelease?: string): Promise<E2EResult> {
  const rel = resolveReleaseDir(targetRelease);
  const releaseId = rel?.id;
  const runDir = rel?.dir ?? process.cwd();
  if (targetRelease && !rel) {
    return {
      ok: false,
      passed: 0,
      failed: ["test run did not execute"],
      failures: [{ title: "test run did not execute", error: `release ${targetRelease} not found` }],
      output: "",
    };
  }
  const r = await runE2EIn(runDir, specFiles);
  return { ...r, releaseId };
}

async function runE2EIn(runDir: string, specFiles: string[]): Promise<E2EResult> {
  await ensureBrowser();
  const b = await checkBrowserLaunch();
  if (!b.ok) {
    return {
      ok: false,
      passed: 0,
      failed: ["browser cannot launch"],
      failures: [{ title: "browser cannot launch", error: `Missing system libraries: ${b.missingLibs.join(", ") || "unknown"}; run sudo npx playwright install-deps chromium` }],
      output: b.error || "",
    };
  }
  if (!fs.existsSync(path.join(runDir, "playwright.config.ts"))) {
    return {
      ok: false,
      passed: 0,
      failed: ["test run did not execute"],
      failures: [{ title: "test run did not execute", error: `server cwd ${process.cwd()} has no playwright.config.ts (release deleted? restart the server from /opt/genlimitless-os/current)` }],
      output: "",
    };
  }
  const candidates = e2eBaseCandidates();
  // Self-heal: if E2E_BASE_URL is set to something else, also try the local loopback server.
  const loopbackUrl = `http://localhost:${process.env.PORT || 3100}`;
  if (!candidates.includes(loopbackUrl)) candidates.push(loopbackUrl);
  const isLoop = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(u);
  let baseURL = candidates[0];
  const rejected: string[] = [];
  let chosen = false;
  for (const cand of candidates) {
    try {
      const pre = await fetch(`${cand}/api/files/graph`, { headers: { "x-glos-internal": internalToken() }, signal: AbortSignal.timeout(15_000) });
      if (pre.status === 401 || pre.status === 403) {
        const localFp = tokenFingerprint();
        const serverFp = pre.headers.get("x-glos-fp") || "none";
        let bodyText = "";
        try { bodyText = (await pre.text()).slice(0, 200); } catch { /* ignore */ }
        const hdrNames = Array.from(pre.headers.keys()).join(",");
        const why = explainTokenRejection({ status: pre.status, localFp, serverFp, body: bodyText, host: cand });
        rejected.push(`${cand} [${why}; response headers: ${hdrNames}] (${pre.status}, local fp ${localFp}, server fp ${serverFp}${serverFp !== "none" && serverFp !== localFp ? " MISMATCH" : ""}, DATA_DIR ${DATA_DIR}, ${isLoop(cand) ? "loopback host: the server on that port uses a different auth secret/data dir, restart from /opt/genlimitless-os/current" : "non-loopback host: unset E2E_BASE_URL"})`);
        continue;
      }
      baseURL = cand;
      chosen = true;
      break;
    } catch { /* unreachable: skip this candidate */ }
  }
  if (!chosen && rejected.length > 0) {
    const title = "test run did not execute: server rejected the internal test token";
    return { ok: false, passed: 0, failed: [title], failures: [{ title, error: `Tried: ${rejected.join(", ")}. same-process token rejected: the answering server uses a different AUTH_CODE_SECRET/SESSION_SECRET or data dir, or the request was not seen as loopback. Check the server env and restart from /opt/genlimitless-os/current. ~130 tests were not run.` }], output: "" };
  }
  const startedMs = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(process.cwd(), "node_modules/@playwright/test/cli.js"), "test", "--reporter=json", ...specFiles],
      { cwd: runDir, env: { ...process.env, E2E_FIXTURES: "1", E2E_BASE_URL: baseURL, E2E_INTERNAL_TOKEN: internalToken(), PLAYWRIGHT_JSON_OUTPUT_NAME: REPORT }, timeout: 45 * 60_000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const stale = staleReportResult(REPORT, startedMs, err, String(stderr || ""), String(stdout || ""));
        if (stale) {
          resolve(stale);
          return;
        }
        const { passed, failed, failures } = failedTitles();
        resolve({ ok: !err && failed.length === 0, passed, failed, failures, output: `${String(stderr || "")}\n${String(stdout || "")}`.slice(-2000) });
      }
    );
  });
}

/** Nightly: run tests, open/close an issue, and alert Owner on new breakage. */
export async function nightlySelfTest() {
  const result = await runE2E();
  const open = db
    .prepare(`SELECT id FROM issues WHERE source=? AND status='open'`)
    .all(SOURCE) as { id: number }[];

  if (result.ok) {
    for (const i of open)
      db.prepare(`UPDATE issues SET status='resolved', resolved_at=datetime('now') WHERE id=?`).run(i.id);
    return result;
  }
  if (open.length === 0) {
    logIssue(SOURCE, `${result.failed.length} UI test(s) failing: ${result.failed.join("; ")}`, result);
    await notifyOwner({
      message: `Something in the OS broke — ${result.failed.length} check(s) failing (${result.failed[0]}). Details in Settings.`,
      reason: "nightly click-through tests started failing",
    });
  }
  return result;
}
