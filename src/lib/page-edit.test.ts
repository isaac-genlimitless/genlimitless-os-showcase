// Pure unit test. Never sends anything, never triggers an agent.
import test from "node:test";
import assert from "node:assert/strict";
import { applyPageEdits, listTables, viewPageBody } from "./page-edit";

const LEDGER = [
  "## Ledger",
  "| Name | Owes | Next |",
  "|---|---|---|",
  "| a | 1 | x |",
  "",
  "## Archive",
  "| Name | Owes |",
  "|---|---|",
  "| b | 2 |",
  "",
  "## Other",
  "| Who | Owes | Date | Note |",
  "|---|---|---|---|",
  "| c | 3 | d | n |",
].join("\n");

test("ambiguous header_line lists every match", () => {
  assert.throws(
    () => applyPageEdits(LEDGER, [{ op: "append_table_row", header_line: "Owes", row: "| q | 1 | 2 |" }]),
    (e: Error) => /matches 3 tables/.test(e.message) && /#1/.test(e.message) && /#2/.test(e.message) && /#3/.test(e.message) && /3 cols/.test(e.message) && /4 cols/.test(e.message) && /## Ledger/.test(e.message)
  );
});

test("table_index picks only that table", () => {
  const out = applyPageEdits(LEDGER, [{ op: "append_table_row", table_index: 2, row: "| z | 9 |" }]);
  assert.equal(out.split("\n")[9], "| z | 9 |");
  assert.equal(out.split("\n").length, LEDGER.split("\n").length + 1);
});

test("exact full header_line wins when substring of another", () => {
  const out = applyPageEdits(LEDGER, [{ op: "append_table_row", header_line: "| Name | Owes |", row: "| z | 9 |" }]);
  assert.equal(out.split("\n")[9], "| z | 9 |");
});

test("table_index out of range and combined params", () => {
  assert.throws(() => applyPageEdits(LEDGER, [{ op: "append_table_row", table_index: 7, row: "| z |" }]), /table_index 7 out of range, page has 3 tables/);
  assert.throws(() => applyPageEdits(LEDGER, [{ op: "append_table_row", table_index: 1, heading: "Ledger", row: "| a | b | c |" }]), /exactly one/);
});

test("listTables", () => {
  const t = listTables(LEDGER);
  assert.equal(t.length, 3);
  assert.deepEqual([t[2].index, t[2].columns, t[2].heading, t[2].rows], [3, 4, "## Other", 1]);
  assert.equal(t[0].heading, "## Ledger");
});

test("viewPageBody modes", () => {
  assert.deepEqual(viewPageBody("short"), { body: "short", total_chars: 5 });
  const big = "x".repeat(30001);
  const v = viewPageBody(big);
  assert.equal(v.truncated, true);
  assert.equal(v.body!.length, 30000);
  assert.equal(v.next_offset, 30000);
  const s = viewPageBody("abcdef", { offset: 2, limit: 2 });
  assert.deepEqual(s, { body: "cd", total_chars: 6, next_offset: 4 });
  const t = viewPageBody(LEDGER, { tables_only: true });
  assert.equal(t.body, undefined);
  assert.equal(t.tables!.length, 3);
});

const PAGE = [
  "# Title",
  "",
  "## Alpha",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "## Beta",
  "| name | role | status |",
  "|---|---|---|",
  "| x | y | z |",
  "",
  "## Gamma",
  "| a | b |",
  "|---|---|",
  "| 9 | 9 |",
].join("\n");

test("replace_text happy path, literal $&", () => {
  assert.equal(applyPageEdits("hello world", [{ op: "replace_text", find: "world", with: "there" }]), "hello there");
  assert.equal(applyPageEdits("a X b", [{ op: "replace_text", find: "X", with: "$&$&" }]), "a $&$& b");
});

test("not found and ambiguous errors", () => {
  assert.throws(() => applyPageEdits("abc", [{ op: "replace_text", find: "zz", with: "" }]), /edit 1 \(replace_text\): text not found/);
  assert.throws(() => applyPageEdits("aa", [{ op: "replace_text", find: "a", with: "b" }]), /found 2 times, ambiguous/);
  assert.throws(() => applyPageEdits("aa", [{ op: "insert_after", anchor: "a", text: "b" }]), /ambiguous/);
});

test("insert_after / insert_before", () => {
  assert.equal(applyPageEdits("one\ntwo\n", [{ op: "insert_after", anchor: "one\n", text: "mid\n" }]), "one\nmid\ntwo\n");
  assert.equal(applyPageEdits("one\ntwo\n", [{ op: "insert_before", anchor: "two", text: "mid\n" }]), "one\nmid\ntwo\n");
});

test("append_table_row by heading targets right table", () => {
  const out = applyPageEdits(PAGE, [{ op: "append_table_row", heading: "## beta", row: "| p | q | r |" }]);
  const lines = out.split("\n");
  assert.equal(lines[11], "| p | q | r |");
  assert.equal(lines.length, PAGE.split("\n").length + 1);
});

test("append_table_row by header_line and normalization", () => {
  const out = applyPageEdits(PAGE, [{ op: "append_table_row", header_line: "name | role", row: "p | q | r" }]);
  assert.ok(out.includes("| x | y | z |\n| p | q | r |\n"));
});

test("table row errors", () => {
  assert.throws(() => applyPageEdits(PAGE, [{ op: "append_table_row", heading: "Beta", row: "| a | b |" }]), /3/);
  assert.throws(() => applyPageEdits("## H\ntext", [{ op: "append_table_row", heading: "H", row: "| a |" }]), /no table/);
  assert.throws(() => applyPageEdits("## H\n| a |\n## H\n| b |", [{ op: "append_table_row", heading: "H", row: "| a |" }]), /ambiguous/);
});

test("atomic: second edit fails, input unchanged", () => {
  const input = "abc";
  assert.throws(
    () => applyPageEdits(input, [{ op: "replace_text", find: "a", with: "z" }, { op: "replace_text", find: "nope", with: "" }]),
    /edit 2/
  );
  assert.equal(input, "abc");
});

test("large page: one row inserted, all else identical", () => {
  const parts: string[] = ["# Big"];
  for (let s = 0; s < 6; s++) {
    parts.push("", `## Section ${s}`, "Lorem ipsum dolor sit amet. ".repeat(100));
    if (s === 1 || s === 4) {
      parts.push("", s === 1 ? "| k | v |" : "| id | val |", "|---|---|");
      for (let r = 0; r < 20; r++) parts.push(`| ${r} | value ${r} |`);
    }
  }
  const page = parts.join("\n");
  assert.ok(page.length > 16000);
  const row = "| 99 | new |";
  const out = applyPageEdits(page, [{ op: "append_table_row", header_line: "id | val", row }]);
  assert.equal(out.length, page.length + row.length + 1);
  const a = page.split("\n");
  const b = out.split("\n");
  const idx = b.indexOf(row);
  assert.equal(b[idx - 1], "| 19 | value 19 |");
  b.splice(idx, 1);
  assert.deepEqual(b, a);
});

test("CRLF normalized", () => {
  assert.equal(applyPageEdits("a\r\nb", [{ op: "replace_text", find: "a\r\nb", with: "c\r\nd" }]), "c\nd");
});
