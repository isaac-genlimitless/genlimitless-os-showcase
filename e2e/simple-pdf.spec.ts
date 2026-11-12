import { test, expect } from "@playwright/test";
import zlib from "zlib";
import { parseMarkdown } from "../src/lib/export";
import { simplePdf } from "../src/lib/simple-pdf";

function contentText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  let all = "";
  for (const m of raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)) all += zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1") + "\n";
  return all;
}

test("built-in PDF writer makes a valid multi-page PDF with the text in it", () => {
  const md = "# Jane Doe\n\n**Bold** line with “quotes” – dash\n\n- bullet one\n\n> a quote\n\n```\ncode line\n```\n\n---\n\n" +
    Array.from({ length: 120 }, (_, i) => `Paragraph ${i} ` + "word ".repeat(30)).join("\n\n");
  const buf = simplePdf(parseMarkdown(md));
  const raw = buf.toString("latin1");
  expect(raw.startsWith("%PDF-1.4")).toBe(true);
  expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
  const start = Number(/startxref\n(\d+)/.exec(raw)![1]);
  expect(raw.slice(start, start + 4)).toBe("xref");
  expect((raw.match(/\/Type \/Page /g) || []).length).toBeGreaterThan(1);
  const objOffsets = [...raw.matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
  objOffsets.forEach((o, i) => expect(raw.slice(o, o + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  expect(contentText(buf)).toContain("<4a616e6520446f65>"); // "Jane Doe"
  expect(raw).not.toContain("localhost");
});

test("built-in PDF writer survives an empty doc and a 5000-char unbroken word", () => {
  expect(simplePdf([]).subarray(0, 5).toString()).toBe("%PDF-");
  const big = simplePdf(parseMarkdown("x".repeat(5000)), "Title");
  expect(big.subarray(0, 5).toString()).toBe("%PDF-");
  expect(big.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
});
