// Pure targeted-edit helpers for Files pages. No DB, no imports.
export type PageEdit = {
  op: "replace_text" | "insert_after" | "insert_before" | "append_table_row";
  find?: string;
  with?: string;
  anchor?: string;
  text?: string;
  row?: string;
  heading?: string;
  header_line?: string;
  table_index?: number;
};

const nl = (s: string) => s.replace(/\r\n/g, "\n");
const isTableLine = (l: string) => /^\s*\|/.test(l);
const isHeadingLine = (l: string) => /^\s{0,3}#{1,6}(\s|$)/.test(l);
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function headingText(l: string): string {
  let t = l.trim().replace(/^#+/, "").replace(/#+\s*$/, "").trim();
  t = t.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
  return t.toLowerCase();
}

function countCells(line: string): number {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  let n = 1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\") i++;
    else if (t[i] === "|") n++;
  }
  return n;
}

function uniqueIndex(body: string, needle: string | undefined, label: string): number {
  if (needle === undefined || needle === "") throw new Error(`${label} is required and must be non-empty`);
  const n = nl(needle);
  let count = 0;
  let first = -1;
  let from = 0;
  for (;;) {
    const i = body.indexOf(n, from);
    if (i < 0) break;
    if (first < 0) first = i;
    count++;
    from = i + 1;
  }
  if (count === 0) throw new Error("text not found");
  if (count > 1) throw new Error(`found ${count} times, ambiguous: include more surrounding text`);
  return first;
}

type TableSpan = { start: number; end: number };

function scanTables(lines: string[]): TableSpan[] {
  const tables: TableSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTableLine(lines[i]) && (i === 0 || !isTableLine(lines[i - 1]))) {
      let j = i;
      while (j + 1 < lines.length && isTableLine(lines[j + 1])) j++;
      tables.push({ start: i, end: j });
    }
  }
  return tables;
}

// Header line with outer pipes and cell padding removed, whitespace collapsed.
function normHeader(s: string): string {
  let t = collapse(s);
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim()).join("|");
}

function headingFor(lines: string[], start: number): string {
  for (let i = start - 1; i >= 0; i--) if (isHeadingLine(lines[i])) return lines[i].trim();
  return "";
}

export type TableInfo = { index: number; header_line: string; columns: number; heading: string; start_line: number; rows: number };

export function listTables(body: string): TableInfo[] {
  const lines = nl(body || "").split("\n");
  return scanTables(lines).map((t, i) => {
    const h = lines[t.start].trim();
    // rows = data rows, excluding header and the |---| separator line
    const sep = t.end > t.start && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[t.start + 1]) ? 1 : 0;
    return {
      index: i + 1,
      header_line: h.length > 160 ? h.slice(0, 160) + "…" : h,
      columns: countCells(lines[t.start]),
      heading: headingFor(lines, t.start),
      start_line: t.start + 1,
      rows: Math.max(0, t.end - t.start - sep),
    };
  });
}

function describeTables(lines: string[], all: TableSpan[], pick: TableSpan[]): string {
  return pick
    .map((t) => {
      const h = lines[t.start].trim();
      const hh = h.length > 160 ? h.slice(0, 160) + "…" : h;
      const head = headingFor(lines, t.start);
      return `#${all.indexOf(t) + 1} "${hh}" (${countCells(lines[t.start])} cols${head ? `, under "${head}"` : ""})`;
    })
    .join("; ");
}

export const PAGE_VIEW_LIMIT = 30000;

export type PageView = { body?: string; total_chars: number; truncated?: boolean; next_offset?: number | null; tables?: TableInfo[]; hint?: string };

// Pure helper for get_page: decides how much of a body to return.
export function viewPageBody(body: string, opts: { offset?: number; limit?: number; tables_only?: boolean } = {}): PageView {
  const b = body || "";
  const total = b.length;
  if (opts.tables_only) return { total_chars: total, tables: listTables(b) };
  if (opts.offset !== undefined || opts.limit !== undefined) {
    const off = Math.max(0, Math.floor(opts.offset ?? 0));
    const lim = Math.max(1, Math.floor(opts.limit ?? PAGE_VIEW_LIMIT));
    const end = Math.min(total, off + lim);
    return { body: b.slice(off, end), total_chars: total, next_offset: end < total ? end : null };
  }
  if (total <= PAGE_VIEW_LIMIT) return { body: b, total_chars: total };
  return {
    body: b.slice(0, PAGE_VIEW_LIMIT),
    truncated: true,
    total_chars: total,
    next_offset: PAGE_VIEW_LIMIT,
    tables: listTables(b),
    hint: "Page is large. Page through with get_page offset/limit, or use tables_only for a table outline (then append_table_row with table_index).",
  };
}

function appendRow(body: string, e: PageEdit): string {
  if (e.row === undefined) throw new Error("row is required");
  const hasH = e.heading !== undefined && e.heading !== "";
  const hasL = e.header_line !== undefined && e.header_line !== "";
  const hasI = e.table_index !== undefined && e.table_index !== null;
  if ((hasH ? 1 : 0) + (hasL ? 1 : 0) + (hasI ? 1 : 0) !== 1) {
    throw new Error("provide exactly one of heading, header_line or table_index");
  }
  const rowRaw = nl(e.row).trim();
  if (!rowRaw || rowRaw.includes("\n")) throw new Error("row must be a single non-empty line");
  const lines = body.split("\n");
  const tables = scanTables(lines);
  let target: { start: number; end: number } | undefined;
  if (hasI) {
    const n = e.table_index as number;
    if (!Number.isInteger(n) || n < 1 || n > tables.length) {
      throw new Error(`table_index ${n} out of range, page has ${tables.length} table${tables.length === 1 ? "" : "s"}`);
    }
    target = tables[n - 1];
  } else if (hasH) {
    const want = headingText(nl(e.heading!));
    const hs: number[] = [];
    lines.forEach((l, i) => {
      if (isHeadingLine(l) && headingText(l) === want) hs.push(i);
    });
    if (hs.length === 0) throw new Error(`heading not found: ${e.heading}`);
    if (hs.length > 1) throw new Error(`heading found ${hs.length} times, ambiguous`);
    let next = lines.length;
    for (let i = hs[0] + 1; i < lines.length; i++) {
      if (isHeadingLine(lines[i])) {
        next = i;
        break;
      }
    }
    target = tables.find((t) => t.start > hs[0] && t.start < next);
    if (!target) throw new Error(`no table found under heading: ${e.heading}`);
  } else {
    const want = collapse(nl(e.header_line!));
    let m = tables.filter((t) => collapse(lines[t.start]).includes(want));
    if (m.length === 0) {
      throw new Error(`no table with header line containing: ${e.header_line}. Tables: ${describeTables(lines, tables, tables.slice(0, 12))}${tables.length > 12 ? ` (+${tables.length - 12} more; use get_page tables_only)` : ""}`);
    }
    if (m.length > 1) {
      const exact = m.filter((t) => normHeader(lines[t.start]) === normHeader(want));
      if (exact.length === 1) m = exact;
    }
    if (m.length > 1) {
      throw new Error(`header_line matches ${m.length} tables, ambiguous. Pass table_index, or the exact full header_line. Matches: ${describeTables(lines, tables, m.slice(0, 12))}${m.length > 12 ? ` (+${m.length - 12} more)` : ""}`);
    }
    target = m[0];
  }
  let row = rowRaw;
  if (!row.startsWith("|")) row = "| " + row;
  if (!/(^|[^\\])\|$/.test(row) || row === "|") row = row + " |";
  const want = countCells(lines[target.start]);
  const got = countCells(row);
  if (want !== got) throw new Error(`row has ${got} columns but table header has ${want}`);
  lines.splice(target.end + 1, 0, row);
  return lines.join("\n");
}

export function applyPageEdits(body: string, edits: PageEdit[]): string {
  if (!edits || !edits.length) throw new Error("at least one edit is required");
  let cur = nl(body);
  edits.forEach((e, idx) => {
    try {
      switch (e.op) {
        case "replace_text": {
          const i = uniqueIndex(cur, e.find, "find");
          if (e.with === undefined) throw new Error("with is required");
          cur = cur.slice(0, i) + nl(e.with) + cur.slice(i + nl(e.find!).length);
          break;
        }
        case "insert_after":
        case "insert_before": {
          const i = uniqueIndex(cur, e.anchor, "anchor");
          if (e.text === undefined) throw new Error("text is required");
          const at = e.op === "insert_after" ? i + nl(e.anchor!).length : i;
          cur = cur.slice(0, at) + nl(e.text) + cur.slice(at);
          break;
        }
        case "append_table_row":
          cur = appendRow(cur, e);
          break;
        default:
          throw new Error(`unknown op`);
      }
    } catch (err) {
      throw new Error(`edit ${idx + 1} (${e.op}): ${(err as Error).message}`);
    }
  });
  return cur;
}
