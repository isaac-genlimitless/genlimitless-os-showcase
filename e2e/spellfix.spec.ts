import { test as isolated, expect as isoExpect } from "./isolated-test";
import { test, expect } from "@playwright/test";
import { openTestDb } from "./db-handle";
import { cleanupFilesPages } from "./test-cleanup";
import { blocksToMarkdown } from "../src/lib/blocks";
import { fixBlocks, sanitiseFixes, verifyBlocksShape, verifyWordOnly } from "../src/lib/spellfix-core";

// Pure-function tests: no DB, no model, no agent, nothing sent.
const para = (text: string, id = "b1") => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });
const textOf = (b: any) => b.content.map((c: any) => c.text).join("");

test("a wording or structure change is rejected", () => {
  expect(verifyWordOnly("I should go home", "I should go back home").ok).toBe(false); // word added
  expect(verifyWordOnly("good day", "great day").ok).toBe(false); // not a small spelling edit
  expect(verifyWordOnly("teh cat sat", "the, cat sat").ok).toBe(false); // punctuation added
  expect(verifyWordOnly("teh cat", "The cat").ok).toBe(false); // capitalization style
  expect(verifyWordOnly("one two", "one\ntwo").ok).toBe(false); // layout
  expect(verifyWordOnly("teh cat", "the cat").ok).toBe(true);
  const before = [para("teh cat", "a")];
  expect(verifyBlocksShape(before, [para("the cat", "a"), para("extra", "b")]).ok).toBe(false); // block added
  expect(verifyBlocksShape(before, [{ ...para("the cat", "a"), type: "heading" }]).ok).toBe(false); // block type changed
  expect(verifyBlocksShape(before, [para("the cat", "a")]).ok).toBe(true);
  expect(sanitiseFixes({ fixes: [{ wrong: "cat", right: "elephants" }, { wrong: "Paris", right: "paris" }, { wrong: "shjould", right: "should" }] })).toEqual([{ wrong: "shjould", right: "should" }]);
});

test("URLs, emails, code, quotes, scripture and @Chief lines are never touched", () => {
  const blocks = [
    para("Email teh@teh.com or open https://teh.example.com/teh-guide today", "a"),
    para("I need to call my mom teh @Chief", "b"),
    { id: "c", type: "paragraph", props: {}, content: [{ type: "text", text: "teh", styles: { code: true } }, { type: "link", href: "https://x.com", content: [{ type: "text", text: "teh", styles: {} }] }], children: [] },
    para('He said "teh best" and read Alma 32:21 teh', "d"),
    { id: "e", type: "codeBlock", props: {}, content: [{ type: "text", text: "const teh = 1", styles: {} }], children: [] },
  ];
  const { blocks: out, changes } = fixBlocks(blocks, [{ wrong: "teh", right: "the" }]);
  expect(changes.length).toBe(0);
  expect(JSON.stringify(out)).toBe(JSON.stringify(blocks));
});

test("a real typo (shjould -> should) is fixed, everything else stays", () => {
  const blocks = [para("I shjould go to teh store. Shjould we go?", "a")];
  const { blocks: out, changes } = fixBlocks(blocks, [{ wrong: "shjould", right: "should" }]);
  expect(textOf(out[0])).toBe("I should go to teh store. Should we go?");
  expect(changes.map((c) => `${c.wrong}>${c.right}`)).toEqual(["shjould>should", "Shjould>Should"]);
  expect(verifyBlocksShape(blocks, out).ok).toBe(true);
});

// Job-level test, isolated server only. Stub checker: no model call.
isolated.afterEach(() => cleanupFilesPages());
isolated("job fixes only Owner's own old pages, logs and reverts the fix, and never touches agent pages", async () => {
  const { runNightlySpellfix, revertSpellfixChange } = await import("../src/lib/spellfix");
  const blocks = [para("I shjould go home")];
  const body = await blocksToMarkdown(blocks);
  const db = openTestDb();
  const add = (title: string, by: string, age: string) =>
    Number(db.prepare(`INSERT INTO docs (title, body, created_by, kind, content, updated_at) VALUES (?, ?, ?, 'page', ?, datetime('now', ?))`).run(title, body, by, JSON.stringify(blocks), age).lastInsertRowid);
  const mine = add("E2E Spellfix mine", "owner", "-2 hours");
  const agents = add("E2E Spellfix agent", "agent", "-2 hours");
  const recent = add("E2E Spellfix recent", "owner", "-5 minutes");
  const before = (db.prepare(`SELECT updated_at FROM docs WHERE id=?`).get(mine) as any).updated_at;
  try {
    const r = await runNightlySpellfix({ force: true, check: async () => [{ wrong: "shjould", right: "should" }] });
    isoExpect(r!.words).toBeGreaterThanOrEqual(1);
    const row = (id: number) => db.prepare(`SELECT body, updated_at FROM docs WHERE id=?`).get(id) as any;
    isoExpect(row(mine).body).toContain("I should go home");
    isoExpect(row(mine).updated_at).toBe(before); // not bumped
    isoExpect(row(agents).body).toContain("shjould"); // agent page untouched
    isoExpect(row(recent).body).toContain("shjould"); // edited <30 min ago: skipped
    const ch = db.prepare(`SELECT id FROM spellfix_changes WHERE page_id=?`).get(mine) as any;
    isoExpect(db.prepare(`SELECT COUNT(*) n FROM spellfix_versions WHERE page_id=?`).get(mine)).toEqual({ n: 1 });
    isoExpect((await revertSpellfixChange(ch.id)).ok).toBe(true);
    isoExpect(row(mine).body).toContain("shjould");
  } finally {
    db.close();
  }
});
