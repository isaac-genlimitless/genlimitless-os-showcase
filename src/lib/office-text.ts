// Text extraction for .docx/.xlsx/.pptx using only Node built-ins (zlib, Buffer).
// Hand-rolled zip reader + linear regex XML scans. No DOCTYPE/entity expansion,
// zip-bomb guards throughout. extractOfficeText never throws.
import zlib from "zlib";

export const MAX_TEXT_CHARS = 200_000;
export const MAX_SHEET_ROWS = 2_000;
const MAX_ENTRIES = 2_000;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_INFLATED = 50 * 1024 * 1024;
const MAX_RATIO = 100;
const RATIO_FLOOR_BYTES = 1024 * 1024; // ratio only judged on entries larger than this
const MAX_COLUMNS = 200;
const TRUNC_MARKER = `[truncated: showing first ${MAX_TEXT_CHARS} characters]`;

type ZipEntry = {
  name: string;
  flags: number;
  method: number;
  compSize: number;
  size: number;
  localOffset: number;
};
type Budget = { used: number };

export type OfficeResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: string };

function readZipIndex(buf: Buffer): Map<string, ZipEntry> {
  if (buf.length < 22) throw new Error("not a zip file (too small)");
  const minPos = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory)");
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) throw new Error("zip64 archives are not supported");
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw new Error("multi-disk zip not supported");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("zip64 archives are not supported");
  if (total > MAX_ENTRIES) throw new Error("zip has too many entries");
  if (cdOffset > buf.length || cdOffset + cdSize > buf.length) throw new Error("central directory out of bounds");

  const entries = new Map<string, ZipEntry>();
  let pos = cdOffset;
  let declaredTotal = 0;
  for (let n = 0; n < total; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new Error("bad central directory entry");
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLen + extraLen + commentLen;
    if (next > buf.length) throw new Error("central directory entry out of bounds");
    if (flags & 1) throw new Error("encrypted zip not supported");
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new Error("zip64 archives are not supported");
    if (size > MAX_ENTRY_BYTES) throw new Error("zip entry too large");
    declaredTotal += size;
    if (declaredTotal > MAX_TOTAL_INFLATED) throw new Error("zip total size too large");
    if (size > RATIO_FLOOR_BYTES && (compSize === 0 || size / compSize > MAX_RATIO)) throw new Error("zip compression ratio too high");
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    entries.set(name, { name, flags, method, compSize, size, localOffset });
    pos = next;
  }
  return entries;
}

function inflateEntry(buf: Buffer, entry: ZipEntry, budget: Budget): Buffer {
  const off = entry.localOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) throw new Error("bad local header");
  const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
  const end = start + entry.compSize;
  if (start > buf.length || end > buf.length) throw new Error("entry data out of bounds");
  const data = buf.subarray(start, end);
  let out: Buffer;
  if (entry.method === 0) {
    if (data.length > MAX_ENTRY_BYTES) throw new Error("zip entry too large");
    out = Buffer.from(data);
  } else if (entry.method === 8) {
    // Cap at the declared size: a header that lies can't expand past it (and never past the hard limit).
    const cap = Math.max(1, Math.min(entry.size, MAX_ENTRY_BYTES));
    out = zlib.inflateRawSync(data, { maxOutputLength: cap });
  } else {
    throw new Error("unsupported zip compression method");
  }
  if (out.length !== entry.size) throw new Error("zip entry size mismatch");
  budget.used += out.length;
  if (budget.used > MAX_TOTAL_INFLATED) throw new Error("zip inflated size too large");
  return out;
}

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,8}|#\d{1,8}|amp|lt|gt|quot|apos);/g, (m, g: string) => {
    switch (g) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
    }
    const cp = g[1] === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "";
    return String.fromCodePoint(cp);
  });
}

function colIndex(ref: string): number {
  const m = /^([A-Za-z]+)/.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : undefined;
}

class Out {
  parts: string[] = [];
  len = 0;
  full = false;
  add(s: string) {
    if (this.full || !s) return;
    const remaining = MAX_TEXT_CHARS - this.len;
    if (s.length > remaining) {
      this.parts.push(s.slice(0, remaining));
      this.len = MAX_TEXT_CHARS;
      this.full = true;
    } else {
      this.parts.push(s);
      this.len += s.length;
    }
  }
}

function getPart(buf: Buffer, idx: Map<string, ZipEntry>, name: string, budget: Budget): string | null {
  const e = idx.get(name);
  if (!e) return null;
  return inflateEntry(buf, e, budget).toString("utf8");
}

function runsText(xml: string, re: RegExp, out: Out) {
  let m: RegExpExecArray | null;
  while (!out.full && (m = re.exec(xml))) {
    if (m[1] !== undefined) out.add(decodeXml(m[1]));
    else if (m[0].startsWith("</")) out.add("\n");
    else if (/^<w:tab/.test(m[0])) out.add("\t");
    else out.add("\n");
  }
}

const W_RE = () => /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<\/w:p>|<w:tab(?:\s[^>]*)?\/?>|<w:br(?:\s[^>]*)?\/?>/g;
const A_RE = () => /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<\/a:p>|<a:br(?:\s[^>]*)?\/?>/g;

function docxText(buf: Buffer, idx: Map<string, ZipEntry>, budget: Budget, out: Out) {
  const main = getPart(buf, idx, "word/document.xml", budget);
  if (main === null) throw new Error("missing word/document.xml");
  runsText(main, W_RE(), out);
  const foot = getPart(buf, idx, "word/footnotes.xml", budget);
  if (foot !== null && !out.full) {
    out.add("\n");
    runsText(foot, W_RE(), out);
  }
}

function numbered(idx: Map<string, ZipEntry>, re: RegExp): { n: number; name: string }[] {
  const list: { n: number; name: string }[] = [];
  for (const name of idx.keys()) {
    const m = re.exec(name);
    if (m) list.push({ n: parseInt(m[1], 10), name });
  }
  return list.sort((a, b) => a.n - b.n);
}

function pptxText(buf: Buffer, idx: Map<string, ZipEntry>, budget: Budget, out: Out) {
  const slides = numbered(idx, /^ppt\/slides\/slide(\d+)\.xml$/);
  if (slides.length === 0) throw new Error("missing ppt/slides");
  for (const s of slides) {
    if (out.full) break;
    out.add(`## Slide ${s.n}\n`);
    runsText(getPart(buf, idx, s.name, budget) ?? "", A_RE(), out);
    const notes = getPart(buf, idx, `ppt/notesSlides/notesSlide${s.n}.xml`, budget);
    if (notes !== null && !out.full) {
      const sub = new Out();
      runsText(notes, A_RE(), sub);
      const t = sub.parts.join("").trim();
      if (t) out.add(`\nNotes: ${t}\n`);
    }
    out.add("\n");
  }
}

function innerText(xml: string): string {
  const re = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
  let m: RegExpExecArray | null;
  let s = "";
  while ((m = re.exec(xml))) s += decodeXml(m[1]);
  return s;
}

function xlsxText(buf: Buffer, idx: Map<string, ZipEntry>, budget: Budget, out: Out) {
  const shared: string[] = [];
  const ss = getPart(buf, idx, "xl/sharedStrings.xml", budget);
  if (ss !== null) {
    const re = /<si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/si>)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ss))) shared.push(m[1] ? innerText(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, "")) : "");
  }

  let sheets: { name: string; part: string }[] = [];
  const wb = getPart(buf, idx, "xl/workbook.xml", budget);
  const rels = getPart(buf, idx, "xl/_rels/workbook.xml.rels", budget);
  if (wb !== null && rels !== null) {
    const relMap = new Map<string, string>();
    for (const t of rels.match(/<Relationship\s[^>]*>/g) ?? []) {
      const id = attr(t, "Id");
      const target = attr(t, "Target");
      if (id && target) relMap.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    }
    for (const t of wb.match(/<sheet\s[^>]*>/g) ?? []) {
      const name = attr(t, "name");
      const rid = attr(t, "r:id");
      const part = rid ? relMap.get(rid) : undefined;
      if (name && part && idx.has(part)) sheets.push({ name, part });
    }
  }
  if (sheets.length === 0) {
    sheets = numbered(idx, /^xl\/worksheets\/sheet(\d+)\.xml$/).map((s) => ({ name: `Sheet${s.n}`, part: s.name }));
    if (sheets.length === 0) {
      const names = [...idx.keys()].filter((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k)).sort();
      sheets = names.map((k, i) => ({ name: `Sheet${i + 1}`, part: k }));
    }
  }
  if (sheets.length === 0) throw new Error("no worksheets found");

  for (const sh of sheets) {
    if (out.full) break;
    out.add(`## Sheet: ${sh.name}\n`);
    const xml = getPart(buf, idx, sh.part, budget) ?? "";
    const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
    let rm: RegExpExecArray | null;
    let rows = 0;
    while (!out.full && (rm = rowRe.exec(xml))) {
      if (!rm[1]) continue;
      const cells: string[] = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm: RegExpExecArray | null;
      let next = 0;
      let any = false;
      while ((cm = cellRe.exec(rm[1]))) {
        const attrs = cm[1];
        const body = cm[2] ?? "";
        const ref = attr(attrs, "r");
        const type = attr(attrs, "t") ?? "n";
        let col = ref ? colIndex(ref) : -1;
        if (col < 0) col = next;
        next = col + 1;
        if (col >= MAX_COLUMNS) continue;
        let val = "";
        if (type === "inlineStr") val = innerText(body);
        else {
          const v = /<v(?:\s[^>]*)?>([^<]*)<\/v>/.exec(body);
          if (v) {
            const raw = decodeXml(v[1]);
            if (type === "s") val = shared[parseInt(raw, 10)] ?? "";
            else if (type === "b") val = raw === "1" ? "TRUE" : "FALSE";
            else val = raw;
          }
        }
        while (cells.length < col) cells.push("");
        cells[col] = val.replace(/[\t\r\n]+/g, " ");
        if (val) any = true;
      }
      if (!any) continue;
      if (rows >= MAX_SHEET_ROWS) {
        out.add(`[sheet truncated at ${MAX_SHEET_ROWS} rows]\n`);
        break;
      }
      rows++;
      out.add(cells.join("\t") + "\n");
    }
    out.add("\n");
  }
}

export function extractOfficeText(buf: Buffer, ext: "docx" | "xlsx" | "pptx"): OfficeResult {
  try {
    if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, reason: "empty file" };
    const idx = readZipIndex(buf);
    const budget: Budget = { used: 0 };
    const out = new Out();
    if (ext === "docx") docxText(buf, idx, budget, out);
    else if (ext === "pptx") pptxText(buf, idx, budget, out);
    else if (ext === "xlsx") xlsxText(buf, idx, budget, out);
    else return { ok: false, reason: "unsupported type" };
    let text = out.parts.join("");
    if (out.full) text += `\n${TRUNC_MARKER}`;
    return { ok: true, text, truncated: out.full };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "could not read file" };
  }
}
