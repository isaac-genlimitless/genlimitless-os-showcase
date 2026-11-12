import { test, expect } from "./isolated-test";
import { effectiveFixKind } from "../src/lib/agents/fixes";

// Pure function test: never sends anything or runs an agent.
test("on the server every code change goes through GitHub, never an in-place edit", () => {
  expect(effectiveFixKind("local", true)).toBe("github");
  expect(effectiveFixKind(undefined, true)).toBe("github");
  expect(effectiveFixKind("github", true)).toBe("github");
});

test("on the Mac the requested kind is kept, defaulting to local", () => {
  expect(effectiveFixKind("local", false)).toBe("local");
  expect(effectiveFixKind("github", false)).toBe("github");
  expect(effectiveFixKind(undefined, false)).toBe("local");
});

import { parsePorcelain } from "../src/lib/pr-builder";

test("parsePorcelain lists changed files and flags deletions", () => {
  const out = ` M src/a.ts\n?? e2e/new.spec.ts\n D src/gone.ts\nD  src/staged-gone.ts\nR  old.ts -> new.ts\n`;
  const r = parsePorcelain(out);
  expect(r.changed).toEqual(["src/a.ts", "e2e/new.spec.ts", "src/gone.ts", "src/staged-gone.ts", "old.ts -> new.ts"]);
  expect(r.deleted).toEqual(["src/gone.ts", "src/staged-gone.ts"]);
  expect(parsePorcelain("").changed).toEqual([]);
});
