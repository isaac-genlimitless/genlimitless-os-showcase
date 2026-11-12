import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { staleReportResult } from "../src/lib/selftest";

test("stale report is reported as 'did not execute'", () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stale-")), "report.json");
  fs.writeFileSync(p, "{}");
  const r = staleReportResult(p, fs.statSync(p).mtimeMs + 10_000, new Error("boom"), "some stderr");
  expect(r?.ok).toBe(false);
  expect(r?.failed[0]).toContain("did not execute");
  expect(r?.failures[0].error).toContain("boom");
  expect(r?.failures[0].error).toContain("some stderr");
});

test("stale report error includes exit code, signal and stdout", () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stale-")), "report.json");
  fs.writeFileSync(p, "{}");
  const err: any = Object.assign(new Error("Command failed"), { code: 137, signal: "SIGKILL", killed: true });
  const r = staleReportResult(p, fs.statSync(p).mtimeMs + 10_000, err, "", "out-text");
  expect(r?.failures[0].error).toContain("SIGKILL");
  expect(r?.failures[0].error).toContain("137");
  expect(r?.failures[0].error).toContain("out-text");
});

test("missing report surfaces the real error and stdout", () => {
  const r = staleReportResult("/nonexistent/report.json", Date.now(), new Error("boom"), "", "cfg error");
  expect(r?.failures[0].error).toContain("boom");
  expect(r?.failures[0].error).toContain("cfg error");
  expect(r?.failed[0]).toContain("boom");
});

test("title says why the run died (timed out + stderr)", () => {
  const err: any = Object.assign(new Error("Command failed: npx playwright test --reporter=json"), { killed: true, code: null });
  const r = staleReportResult("/nonexistent/report.json", Date.now(), err, "boom");
  expect(r?.failed[0]).toContain("timed out");
  expect(r?.failed[0]).toContain("boom");
});

test("fresh report is not flagged", () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fresh-")), "report.json");
  fs.writeFileSync(p, "{}");
  expect(staleReportResult(p, fs.statSync(p).mtimeMs - 10_000, null, "")).toBeNull();
});
