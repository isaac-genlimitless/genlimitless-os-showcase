import { test, expect } from "@playwright/test";
import { ENGINEERING_ISSUE_TRAILER } from "../src/lib/github";

test("engineering issue trailer runs typegen before tsc and never merges", () => {
  const t = ENGINEERING_ISSUE_TRAILER;
  const typegen = t.indexOf("npx next typegen");
  const tsc = t.indexOf("npx tsc --noEmit");
  expect(typegen).toBeGreaterThanOrEqual(0);
  expect(tsc).toBeGreaterThan(typegen);
  expect(t).toContain("Never merge");
});
