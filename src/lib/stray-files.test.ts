import test from "node:test";
import assert from "node:assert/strict";
import { findStrays } from "./stray-files";

test("flags an unlisted .append file", () => {
  assert.deepEqual(findStrays(["src/x.ts", "src/x.ts.append"], ["src/x.ts"]), ["src/x.ts.append"]);
});

test("keeps a listed .bak", () => {
  assert.deepEqual(findStrays(["src/a.bak"], ["src/a.bak"]), []);
});

test("clean list returns empty", () => {
  assert.deepEqual(findStrays(["src/x.ts", "src/y.tsx"], ["src/x.ts"]), []);
});

test("flags trailing tilde", () => {
  assert.deepEqual(findStrays(["a.ts~"], []), ["a.ts~"]);
});
