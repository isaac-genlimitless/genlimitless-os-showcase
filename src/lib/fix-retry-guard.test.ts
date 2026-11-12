import { test, expect } from "@playwright/test";
import { retryReady, parseBaseNote, baseNote } from "./fix-retry-guard";

const MAIN = "abc1234def5678abc1234def5678abc1234def56";
const row = (over: Record<string, unknown> = {}) => ({ id: 10, proposed_change: "", diagnosis: "", cos_review: "", result: `failed ${baseNote("abc1234")}`, ...over });

test("unmerged parent waits", () => {
  expect(retryReady(row({ proposed_change: "Apply after #5", result: "failed [base 1111111]" }), MAIN, { parentMerged: () => false })).toBe(false);
});

test("same base oid waits", () => {
  expect(retryReady(row(), MAIN, { parentMerged: () => true })).toBe(false);
});

test("merged parent plus new oid retries", () => {
  expect(retryReady(row({ proposed_change: "REQUIRES_FIX: #5" }), MAIN, { parentMerged: () => true })).toBe(true);
});

test("legacy row without a base note retries", () => {
  expect(retryReady(row({ result: "failed" }), MAIN, { parentMerged: () => true })).toBe(true);
  expect(parseBaseNote("failed")).toBeNull();
});
