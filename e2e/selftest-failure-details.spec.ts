import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { failedTitles, staleReportResult } from "../src/lib/selftest";

test("staleReportResult surfaces Playwright stdout in the failure error", () => {
  const r = staleReportResult("/nonexistent/report.json", Date.now(), new Error("Command failed"), "", "Error: Cannot find module X");
  expect(r).not.toBeNull();
  expect(r!.failures[0].error).toContain("Error: Cannot find module X");
});

// run_ui_tests must return each failure's error message, snippet and stack (not just titles).
// Pure: parses a fixture report written to a temp dir. No server, no UI, no live data.

const ESC = String.fromCharCode(27);

test("failedTitles returns error details for failing specs and keeps failed[] titles", () => {
  const report = {
    suites: [
      {
        title: "sample.spec.ts",
        specs: [
          {
            title: "breaks",
            ok: false,
            file: "sample.spec.ts",
            tests: [
              {
                status: "unexpected",
                results: [
                  {
                    error: {
                      message: `${ESC}[31mExpected: 1${ESC}[39m\nReceived: 2`,
                      snippet: "> 5 | expect(2).toBe(1);",
                      stack: "Error: boom\n    at sample.spec.ts:5:1",
                    },
                  },
                ],
              },
            ],
          },
          { title: "works", ok: true, file: "sample.spec.ts", tests: [{ status: "expected", results: [{}] }] },
        ],
      },
    ],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selftest-"));
  const file = path.join(dir, "report.json");
  fs.writeFileSync(file, JSON.stringify(report));
  try {
    const r = failedTitles(file);
    expect(r.passed).toBe(1);
    expect(r.failed).toEqual(["sample.spec.ts › breaks"]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].file).toBe("sample.spec.ts");
    expect(r.failures[0].error).toContain("Expected: 1");
    expect(r.failures[0].error).not.toContain(ESC);
    expect(r.failures[0].snippet).toContain("expect(2).toBe(1)");
    expect(r.failures[0].stack).toContain("boom");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
