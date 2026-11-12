import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

// Node-only static check, no server/DB needed (same category as db-handle.spec.ts). Stops the
// exact #24 bug — a spec that mutates real data via /api/files or /api/docs but never routes through the isolated-server guard (./isolated-test) or the
// isolated DB handle (./db-handle) — from being reintroduced for another table later.

const E2E_DIR = __dirname;

function specFiles(): string[] {
  return fs.readdirSync(E2E_DIR).filter((f) => f.endsWith(".spec.ts"));
}

function allE2eFiles(): string[] {
  return fs.readdirSync(E2E_DIR).filter((f) => f.endsWith(".ts"));
}

// Only calls that actually WRITE against these endpoints are the risk (GET-only specs
// legitimately read Owner's real data on purpose - see playwright.config.ts).
const MUTATING_CALL = /request\.(post|patch|delete|put)\(\s*[`'"][^`'"]*\/api\/(files|docs)/;
const ISOLATED_IMPORT = /from\s+["']\.\/isolated-test["']/;

test("every e2e spec that mutates files/docs via the API imports the isolated-server guard", () => {
  const offenders: string[] = [];
  for (const file of specFiles()) {
    const src = fs.readFileSync(path.join(E2E_DIR, file), "utf8");
    if (MUTATING_CALL.test(src) && !ISOLATED_IMPORT.test(src)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("test processes always use a throwaway DB (config + db.ts guard)", async () => {
  const root = path.join(E2E_DIR, "..");
  const cfg = fs.readFileSync(path.join(root, "playwright.config.ts"), "utf8");
  expect(cfg).toMatch(/process\.env\.GENLIMITLESS_DATA_DIR = isolatedDataDir/);
  expect(cfg).not.toMatch(/if \(startServer\) \{\s*const inherited/);
  expect(fs.readFileSync(path.join(root, "src/lib/db.ts"), "utf8")).toContain("Refusing to open");
  expect(process.env.GENLIMITLESS_DATA_DIR).toMatch(/genlimitless-e2e-data-/);
  const mod: any = await import("../src/lib/db");
  const db = mod.default?.prepare ? mod.default : mod.default.default;
  expect((db.prepare("PRAGMA database_list").get() as any).file).toContain("genlimitless-e2e-data-");
});

// db-handle.ts is the one place allowed to name the real db file (to build the isolated path
// next to it). Matches the quoted form (a string literal in actual hardcoded-path code), not any
// bare mention, so a comment merely referring to the real database by name doesn't trip this.
const DB_LITERAL = /["']genlimitless\.db["']/;

test("no e2e file other than db-handle.ts hardcodes the real genlimitless.db path", () => {
  const offenders: string[] = [];
  for (const file of allE2eFiles()) {
    if (file === "db-handle.ts") continue;
    const src = fs.readFileSync(path.join(E2E_DIR, file), "utf8");
    if (DB_LITERAL.test(src)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
