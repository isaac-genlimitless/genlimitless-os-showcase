import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

// Regression guard (2026-09-25): one agent tool with an open-ended input schema (z.any(),
// z.unknown(), or z.record(...)) made the Agent SDK silently expose NONE of the OS's tools to any
// agent, so every agent ran with only Read/Grep/Glob and said its tools were "down". Free-form
// objects must be passed as JSON text and parsed in the handler instead. Reads source files only.

const TOOL_FILES = ["src/lib/agents/tools.ts", "src/lib/mail-tools.ts"];

test("no agent tool uses an open-ended input schema", () => {
  for (const f of TOOL_FILES) {
    const src = fs.readFileSync(path.join(process.cwd(), f), "utf8");
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => !line.startsWith("//") && /\bz\.(any|unknown|record)\(/.test(line));
    expect(offenders, `${f}: ${offenders.map((o) => `line ${o.n}: ${o.line}`).join("\n")}`).toEqual([]);
  }
});
