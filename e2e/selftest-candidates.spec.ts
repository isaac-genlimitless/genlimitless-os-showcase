import { test, expect } from "@playwright/test";
import { e2eBaseCandidates } from "../src/lib/selftest-target";

test("default candidates are the three loopback URLs, no duplicates", () => {
  const c = e2eBaseCandidates({});
  expect(c).toEqual(["http://localhost:3100", "http://127.0.0.1:3100"]);
  expect(new Set(c).size).toBe(c.length);
});

test("PORT=3101 puts :3101 first", () => {
  const c = e2eBaseCandidates({ PORT: "3101" });
  expect(c[0]).toBe("http://localhost:3101");
  expect(c).toContain("http://127.0.0.1:3100");
  expect(new Set(c).size).toBe(c.length);
});

test("explicit E2E_BASE_URL returns only that", () => {
  expect(e2eBaseCandidates({ E2E_BASE_URL: "http://example.test:9/" })).toEqual(["http://example.test:9"]);
});
