import { test, expect } from "./isolated-test";
import { errorKey, RATE_LIMIT_RE } from "../src/lib/github";

// Pure unit test: never sends anything or runs an agent.

test("rate-limit messages differing only by request ID/timestamp share a key", () => {
  const a = "gh: API rate limit exceeded (HTTP 403) request ID 1A2B:3C4D:5E6F timestamp 2026-10-04 20:28:01 UTC";
  const b = "gh: API rate limit exceeded (HTTP 403) request ID 9F8E:7D6C:5B4A timestamp 2026-10-04 20:30:02 UTC";
  expect(errorKey(a)).toBe(errorKey(b));
});

test("rate-limit messages trigger backoff regex", () => {
  expect(RATE_LIMIT_RE.test("API rate limit exceeded")).toBe(true);
  expect(RATE_LIMIT_RE.test("gh: HTTP 429")).toBe(true);
  expect(RATE_LIMIT_RE.test("gh: something else")).toBe(false);
});
