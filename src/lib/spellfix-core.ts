// Word-only spelling fixes for editor blocks. No DB, no LLM: every safety rule lives here.
export type Fix = { wrong: string; right: string };
export type WordChange = { block_id: string | null; wrong: string; right: string; before_ctx: string; after_ctx: string };
type Edit = { start: number; end: number; replacement: string };
type Seg = { node: any; start: number; end: number };
type Verdict = { ok: true } | { ok: false; reason: string };

const OBJ = "￼";
const WORD_RE = /\p{L}[\p{L}'’]*/gu;
const PLAIN = /^\p{L}[\p{L}'’]*$/u;
const SHELL = /^([^\p{L}]*)(\p{L}[\p{L}'’]*)([^\p{L}]*)$/u;
const SKIP_TYPES = new Set(["codeBlock", "quote"]);
const PROTECT: RegExp[] = [
  /(?:https?:\/\/|www\.)\S+/gu,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu,
  /[@#][\w-]+/gu,
  /\S*[\d_\/\\~=<>{}|^]\S*/gu,
  /"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/gu,
  /\b(?:[1-3] )?(?:[A-Z][\p{L}&.]*\.? )+\d+(?::\d+)?(?:[-–,] ?\d+)*/gu, // scripture-style refs
];
// Non-global copy (no lastIndex state): lines containing a scripture ref are never edited.
const SCRIPTURE = /\b(?:[1-3] )?(?:[A-Z][\p{L}&.]*\.? )+\d+(?::\d+)?(?:[-–,] ?\d+)*/u;

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
export const maxDistance = (w: string) => (w.length >= 9 ? 3 : 2);
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function isAllowedFix(wrong: string, right: string): boolean {
  return (
    PLAIN.test(wrong) && PLAIN.test(right) && wrong.length >= 3 && right.length >= 2 &&
    wrong === wrong.toLowerCase() && right === right.toLowerCase() && wrong !== right &&
    levenshtein(wrong, right) <= maxDistance(wrong)
  );
}

/** Model reply ({fixes:[{wrong,right}]}) -> only the pairs that pass the hard rules. */
export function sanitiseFixes(raw: unknown, max = 40, never: Set<string> = new Set()): Fix[] {
  const list = Array.isArray((raw as any)?.fixes) ? (raw as any).fixes : [];
  const seen = new Map<string, string>();
  for (const f of list) {
    const wrong = typeof f?.wrong === "string" ? f.wrong.trim() : "";
    const right = typeof f?.right === "string" ? f.right.trim() : "";
    if (isAllowedFix(wrong, right) && !never.has(wrong) && !seen.has(wrong)) seen.set(wrong, right);
    if (seen.size >= max) break;
  }
  return [...seen].map(([wrong, right]) => ({ wrong, right }));
}

// ---- verification: "same layout, only single-word substitutions" ----
export function verifyWordOnly(before: string, after: string): Verdict {
  const a = before.split(/(\s+)/), b = after.split(/(\s+)/);
  if (a.length !== b.length) return { ok: false, reason: "token count or layout changed" };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (/^\s+$/.test(a[i]) || /^\s+$/.test(b[i])) return { ok: false, reason: "whitespace changed" };
    const x = SHELL.exec(a[i]), y = SHELL.exec(b[i]);
    if (!x || !y || x[1] !== y[1] || x[3] !== y[3]) return { ok: false, reason: `non-word change: "${a[i]}" -> "${b[i]}"` };
    const w = x[2], r = y[2];
    const sameCase = (w === w.toLowerCase() && r === r.toLowerCase()) || (w === cap(w.toLowerCase()) && r === cap(r.toLowerCase()));
    if (!sameCase) return { ok: false, reason: `capitalization changed: "${w}" -> "${r}"` };
    if (w.length < 3 || levenshtein(w.toLowerCase(), r.toLowerCase()) > maxDistance(w)) return { ok: false, reason: `not a small spelling edit: "${w}" -> "${r}"` };
  }
  return { ok: true };
}

type TextRef = { text: string; locked: boolean };
function collectTexts(v: unknown, locked: boolean, out: TextRef[]) {
  if (Array.isArray(v)) {
    const inline = v.some((x: any) => x?.type === "text" || x?.type === "link");
    const l = locked || (inline && /@chief/i.test(JSON.stringify(v)));
    for (const x of v) collectTexts(x, l, out);
    return;
  }
  if (!v || typeof v !== "object") return;
  const o = v as any;
  const lock = locked || o.type === "link" || o.type === "codeBlock" || o.type === "quote" || !!o.styles?.code;
  if (o.type === "text" && typeof o.text === "string") out.push({ text: o.text, locked: lock });
  for (const k of Object.keys(o)) if (k !== "text") collectTexts(o[k], lock, out);
}

/** Same blocks, same props/styles/ids/order; only unlocked text nodes differ, and only by word-only fixes. */
export function verifyBlocksShape(before: unknown, after: unknown): Verdict {
  const mask = (v: unknown) => JSON.stringify(v, (k, val) => (k === "text" && typeof val === "string" ? "" : val));
  if (mask(before) !== mask(after)) return { ok: false, reason: "block structure changed" };
  const a: TextRef[] = [], b: TextRef[] = [];
  collectTexts(before, false, a);
  collectTexts(after, false, b);
  if (a.length !== b.length) return { ok: false, reason: "text node count changed" };
  for (let i = 0; i < a.length; i++) {
    if (a[i].text === b[i].text) continue;
    if (a[i].locked) return { ok: false, reason: "protected text changed" };
    const v = verifyWordOnly(a[i].text, b[i].text);
    if (!v.ok) return v;
  }
  return { ok: true };
}

// ---- walking blocks ----
const rawText = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (typeof x?.text === "string" ? x.text : rawText(x?.content))).join("") : "");

function flattenInline(content: any[]) {
  let text = "";
  const segs: Seg[] = [];
  const locked = (s: string) => (text += OBJ.repeat(Math.max(1, s.length)));
  for (const c of content) {
    if (!c) continue;
    if (c.type === "text" && typeof c.text === "string" && !c.styles?.code) {
      segs.push({ node: c, start: text.length, end: text.length + c.text.length });
      text += c.text;
    } else if (c.type === "text" && typeof c.text === "string") locked(c.text);
    else if (c.type === "link") locked(rawText(c.content));
    else locked(OBJ);
  }
  return { text, segs };
}

function walk(blocks: any[], fn: (inline: any[], blockId: string | null) => void) {
  for (const b of blocks) {
    if (!b || typeof b !== "object" || SKIP_TYPES.has(b.type)) continue;
    const id = typeof b.id === "string" ? b.id : null;
    if (Array.isArray(b.content)) fn(b.content, id);
    else if (b.content?.type === "tableContent" && Array.isArray(b.content.rows))
      for (const r of b.content.rows) for (const cell of r?.cells || []) { const inl = Array.isArray(cell) ? cell : cell?.content; if (Array.isArray(inl)) fn(inl, id); }
    if (Array.isArray(b.children)) walk(b.children, fn);
  }
}

function protectedMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  for (const re of PROTECT) for (const m of text.matchAll(re)) for (let i = m.index!; i < m.index! + m[0].length; i++) mask[i] = true;
  return mask;
}

function planFixes(text: string, map: Map<string, string>, canApply: (s: number, e: number) => boolean): Edit[] {
  if (/@chief/i.test(text) || SCRIPTURE.test(text)) return [];
  const mask = protectedMask(text);
  const edits: Edit[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const word = m[0].replace(/['’]+$/, "");
    const start = m.index!, end = start + word.length;
    if (mask.slice(start, end).some(Boolean) || !canApply(start, end)) continue;
    if (/[-_\/\\@#]/.test(text[start - 1] ?? "") || /[-_\/\\@#]/.test(text[end] ?? "")) continue;
    const lower = word.toLowerCase();
    const right = map.get(lower);
    if (!right) continue;
    if (word === lower) edits.push({ start, end, replacement: right });
    else if (word === cap(lower) && /^\s*$|[.!?]\s*$/.test(text.slice(0, start))) edits.push({ start, end, replacement: cap(right) });
  }
  return edits;
}

function applyEdits(segs: Seg[], edits: Edit[]) {
  for (const e of [...edits].sort((x, y) => y.start - x.start)) {
    const s = segs.find((g) => g.start <= e.start && e.end <= g.end);
    if (s) s.node.text = s.node.text.slice(0, e.start - s.start) + e.replacement + s.node.text.slice(e.end - s.start);
  }
}

/** The text worth sending to the model: unprotected text of eligible blocks, protected spans blanked. */
export function eligibleText(blocks: unknown[]): string {
  const lines: string[] = [];
  walk(blocks as any[], (inline) => {
    const { text } = flattenInline(inline);
    if (/@chief/i.test(rawText(inline)) || SCRIPTURE.test(rawText(inline))) return;
    const mask = protectedMask(text);
    const t = [...text].map((ch, i) => (ch === OBJ || mask[i] ? " " : ch)).join("").replace(/ {2,}/g, " ").trim();
    if (t) lines.push(t);
  });
  return lines.join("\n");
}

export function fixBlocks(blocks: unknown[], fixes: Fix[]): { blocks: unknown[]; changes: WordChange[] } {
  const map = new Map(fixes.map((f) => [f.wrong, f.right]));
  const out = structuredClone(blocks) as any[];
  const changes: WordChange[] = [];
  walk(out, (inline, blockId) => {
    const f = flattenInline(inline);
    const edits = planFixes(f.text, map, (s, e) => f.segs.some((g) => g.start <= s && e <= g.end));
    if (!edits.length) return;
    applyEdits(f.segs, edits);
    const after = flattenInline(inline).text;
    let shift = 0;
    for (const e of edits) {
      const s = e.start + shift, n = s + e.replacement.length;
      changes.push({ block_id: blockId, wrong: f.text.slice(e.start, e.end), right: e.replacement, before_ctx: after.slice(Math.max(0, s - 24), s), after_ctx: after.slice(n, n + 24) });
      shift += e.replacement.length - (e.end - e.start);
    }
  });
  return { blocks: out, changes };
}

/** Undo one change; ok only if exactly one place still reads before_ctx+right+after_ctx. */
export function revertChange(blocks: unknown[], c: WordChange): { blocks: unknown[]; ok: boolean } {
  const out = structuredClone(blocks) as any[];
  const needle = c.before_ctx + c.right + c.after_ctx;
  const hits: { f: ReturnType<typeof flattenInline>; at: number }[] = [];
  walk(out, (inline, blockId) => {
    if (c.block_id && blockId !== c.block_id) return;
    const f = flattenInline(inline);
    for (let i = f.text.indexOf(needle); i >= 0; i = f.text.indexOf(needle, i + 1)) hits.push({ f, at: i });
  });
  if (hits.length !== 1) return { blocks, ok: false };
  const start = hits[0].at + c.before_ctx.length;
  const seg = hits[0].f.segs.find((g) => g.start <= start && start + c.right.length <= g.end);
  if (!seg) return { blocks, ok: false };
  applyEdits([seg], [{ start, end: start + c.right.length, replacement: c.wrong }]);
  return { blocks: out, ok: true };
}
