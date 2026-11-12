import zlib from "zlib";
import type { Blk, Run } from "./export";

// Pure-JS PDF writer used when headless Chromium is unavailable. Standard Helvetica/Courier fonts,
// WinAnsi text, word wrap, pagination. Cannot fail on a server that can run Node.

type FontKey = "F1" | "F2" | "F3" | "F4" | "F5";
const FONTS: FontKey[] = ["F1", "F2", "F3", "F4", "F5"];
const BASE: Record<FontKey, string> = { F1: "Helvetica", F2: "Helvetica-Bold", F3: "Helvetica-Oblique", F4: "Helvetica-BoldOblique", F5: "Courier" };
// Helvetica advance widths for ASCII 32..126 (per 1000 em); bold is approximated by x1.07.
const HW = [
  ...[278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278],
  ...Array(10).fill(556),
  ...[278, 278, 584, 584, 584, 556, 1015],
  ...[667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611],
  ...[278, 278, 278, 469, 556, 333],
  ...[556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500],
  ...[334, 260, 334, 584],
] as number[];
const CP: Record<number, number> = { 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2026: 0x85, 0x20ac: 0x80, 0x2122: 0x99 };
const PAGE_W = 612, PAGE_H = 792, M = 43.2;

type Tok = { f: FontKey; codes: number[]; w: number; kind: "word" | "space" | "nl" };

function encode(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 0xa0) out.push(32);
    else if (c >= 32 && c <= 126) out.push(c);
    else if (c >= 0xa1 && c <= 0xff) out.push(c);
    else if (CP[c]) out.push(CP[c]);
    else if (c >= 32) out.push(63);
  }
  return out;
}
const fontFor = (r: { b?: boolean; i?: boolean; code?: boolean }): FontKey => (r.code ? "F5" : r.b && r.i ? "F4" : r.b ? "F2" : r.i ? "F3" : "F1");
const charW = (code: number, f: FontKey, size: number) =>
  ((f === "F5" ? 600 : (code >= 32 && code <= 126 ? HW[code - 32] : code === 0x95 ? 350 : 556) * (f === "F2" || f === "F4" ? 1.07 : 1)) * size) / 1000;
const wordW = (codes: number[], f: FontKey, size: number) => codes.reduce((a, c) => a + charW(c, f, size), 0);

function tokenize(runs: Run[], size: number, force: Partial<Run> = {}): Tok[] {
  const toks: Tok[] = [];
  for (const r of runs) {
    const f = fontFor({ b: r.b || force.b, i: r.i || force.i, code: r.code || force.code });
    for (const part of r.t.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        const nls = (part.match(/\n/g) || []).length;
        if (nls) for (let k = 0; k < nls; k++) toks.push({ f, codes: [], w: 0, kind: "nl" });
        else toks.push({ f, codes: [32], w: charW(32, f, size), kind: "space" });
      } else {
        const codes = encode(part);
        toks.push({ f, codes, w: wordW(codes, f, size), kind: "word" });
      }
    }
  }
  return toks;
}

function wrap(toks: Tok[], maxW: number, size: number): Tok[][] {
  const lines: Tok[][] = [];
  let cur: Tok[] = [];
  let w = 0;
  const push = () => {
    while (cur.length && cur[cur.length - 1].kind === "space") cur.pop();
    lines.push(cur);
    cur = [];
    w = 0;
  };
  for (const t of toks) {
    if (t.kind === "nl") { push(); continue; }
    if (t.kind === "space") { if (cur.length) { cur.push(t); w += t.w; } continue; }
    let word = t;
    if (w + word.w > maxW && cur.length) push();
    while (word.w > maxW && word.codes.length > 1) {
      let n = 1;
      while (n < word.codes.length - 1 && wordW(word.codes.slice(0, n + 1), word.f, size) <= maxW) n++;
      const head = word.codes.slice(0, n);
      cur.push({ f: word.f, codes: head, w: wordW(head, word.f, size), kind: "word" });
      push();
      const rest = word.codes.slice(n);
      word = { f: word.f, codes: rest, w: wordW(rest, word.f, size), kind: "word" };
    }
    cur.push(word);
    w += word.w;
  }
  if (cur.length) push();
  return lines;
}

const num = (v: number) => v.toFixed(2);
const hex = (codes: number[]) => "<" + codes.map((c) => c.toString(16).padStart(2, "0")).join("") + ">";

export function simplePdf(blocks: Blk[], heading?: string): Buffer {
  const pages: string[][] = [[]];
  let y = M; // distance from top of page
  const bottom = PAGE_H - M;
  const out = (s: string) => pages[pages.length - 1].push(s);
  const ensure = (h: number) => {
    if (y + h > bottom && y > M) { pages.push([]); y = M; }
  };
  const cw = PAGE_W - 2 * M;

  function drawLines(lines: Tok[][], x0: number, size: number, lh: number, bar = false) {
    for (const line of lines) {
      ensure(lh);
      if (bar) out(`q 0.78 g ${num(M + 2)} ${num(PAGE_H - y - lh)} 2.2 ${num(lh)} re f Q`);
      const baseline = PAGE_H - y - (lh - size) / 2 - size * 0.88;
      let x = x0, sx = x0;
      let seg: { f: FontKey; codes: number[] } | null = null;
      const flush = () => {
        if (seg) out(`BT /${seg.f} ${num(size)} Tf 1 0 0 1 ${num(sx)} ${num(baseline)} Tm ${hex(seg.codes)} Tj ET`);
        seg = null;
      };
      for (const t of line) {
        if (!seg || seg.f !== t.f) { flush(); seg = { f: t.f, codes: [] }; sx = x; }
        for (const c of t.codes) seg.codes.push(c);
        x += t.w;
      }
      flush();
      y += lh;
    }
  }

  const all: Blk[] = heading ? [{ k: "h", level: 1, runs: [{ t: heading }] }, ...blocks] : blocks;
  for (const b of all) {
    if (b.k === "h") {
      const size = [12, 22, 16, 13, 12, 12, 12][b.level] ?? 12;
      const lh = size * 1.25;
      if (y > M) y += size * 0.5;
      ensure(lh + 36);
      drawLines(wrap(tokenize(b.runs, size, { b: true }), cw, size), M, size, lh);
      y += size * 0.2;
    } else if (b.k === "p") {
      drawLines(wrap(tokenize(b.runs, 11), cw, 11), M, 11, 15);
      y += 6;
    } else if (b.k === "li") {
      const ind = M + b.depth * 18;
      ensure(15);
      const mark = encode(b.mark === "•" && b.depth ? "–" : b.mark);
      out(`BT /F1 11 Tf 1 0 0 1 ${num(ind)} ${num(PAGE_H - y - 2 - 11 * 0.88)} Tm ${hex(mark)} Tj ET`);
      drawLines(wrap(tokenize(b.runs, 11), cw - (ind - M) - 16, 11), ind + 16, 11, 15);
      y += 2;
    } else if (b.k === "quote") {
      drawLines(wrap(tokenize(b.runs, 11, { i: true }), cw - 14, 11), M + 14, 11, 15, true);
      y += 6;
    } else if (b.k === "code") {
      y += 2;
      const lines: Tok[][] = [];
      for (const ln of b.text.split("\n")) {
        const codes = encode(ln);
        lines.push(...wrap([{ f: "F5", codes, w: wordW(codes, "F5", 9.5), kind: "word" }], cw - 8, 9.5));
      }
      drawLines(lines, M + 8, 9.5, 12.5);
      y += 6;
    } else {
      ensure(14);
      y += 5;
      out(`q 0.6 G 0.6 w ${num(M)} ${num(PAGE_H - y)} m ${num(PAGE_W - M)} ${num(PAGE_H - y)} l S Q`);
      y += 7;
    }
  }

  const objs: Buffer[] = [];
  const set = (id: number, body: string | Buffer) => { objs[id] = Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"); };
  set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  FONTS.forEach((k, i) => set(3 + i, `<< /Type /Font /Subtype /Type1 /BaseFont /${BASE[k]} /Encoding /WinAnsiEncoding >>`));
  const fontRes = "<< " + FONTS.map((k, i) => `/${k} ${3 + i} 0 R`).join(" ") + " >>";
  const kids: string[] = [];
  pages.forEach((ops, i) => {
    const pid = 8 + 2 * i, cid = 9 + 2 * i;
    kids.push(`${pid} 0 R`);
    const data = zlib.deflateSync(Buffer.from(ops.join("\n"), "latin1"));
    set(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font ${fontRes} >> /Contents ${cid} 0 R >>`);
    set(cid, Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]));
  });
  set(2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`);

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let pos = parts[0].length;
  const offs: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    offs[id] = pos;
    const chunk = Buffer.concat([Buffer.from(`${id} 0 obj\n`, "latin1"), objs[id], Buffer.from("\nendobj\n", "latin1")]);
    parts.push(chunk);
    pos += chunk.length;
  }
  const xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offs.slice(1).map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}
