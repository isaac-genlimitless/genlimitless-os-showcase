import { test, expect } from "@playwright/test";
import { execFileSync, execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { removeCleanupFiles } from "../src/lib/cleanup-apply";

const run = (cmd: string, args: string[], cwd: string) =>
  new Promise<{ ok: boolean; out: string }>((resolve) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout) + String(stderr) }));
  });

test("removeCleanupFiles removes only safe, tracked, unreferenced files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  g("init", "-q");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/unused.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(dir, "src/used.ts"), "export const b = 1;\n");
  fs.writeFileSync(path.join(dir, "src/main.ts"), 'import { b } from "./used";\nexport const c = b;\n');
  fs.writeFileSync(path.join(dir, "src/db.ts"), "export {};\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(dir, "src/untracked.ts"), "export {};\n");

  const res = await removeCleanupFiles(dir, ["src/unused.ts", "src/used.ts", "../x", "src/db.ts", "src/untracked.ts"], run);
  expect(res.removed).toEqual(["src/unused.ts"]);
  expect(res.refused.map((r) => r.file).sort()).toEqual(["../x", "src/db.ts", "src/untracked.ts", "src/used.ts"].sort());
  expect(fs.existsSync(path.join(dir, "src/unused.ts"))).toBe(false);
  expect(fs.existsSync(path.join(dir, "src/used.ts"))).toBe(true);
});
