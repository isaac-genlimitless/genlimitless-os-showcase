import { test, expect } from "@playwright/test";
import { buildPrepText, isActiveFrom } from "../src/lib/prep-text";

// Pure functions only: no DB writes, no sends, no agent runs.

test("buildPrepText is short, plain, and leads with title and first sentence", () => {
  const note = "**Key point first.** " + "Some _markdown_ `code` # detail > more ".repeat(60) + "```\ncode block\n```";
  expect(note.length).toBeGreaterThan(2000);
  const t = buildPrepText("Board Sync", "Mon 9:00 AM", note);
  expect(t.length).toBeLessThan(300);
  expect(t).not.toMatch(/[*#]/);
  expect(t).not.toContain("```");
  expect(t.startsWith("Board Sync")).toBe(true);
  expect(t).toContain("Key point first.");
});

test("isActiveFrom respects the 15 minute window", () => {
  const now = Date.now();
  expect(isActiveFrom(now, [now - 5 * 60_000, null])).toBe(true);
  expect(isActiveFrom(now, [now - 20 * 60_000, null])).toBe(false);
  expect(isActiveFrom(now, [null, null])).toBe(false);
});
