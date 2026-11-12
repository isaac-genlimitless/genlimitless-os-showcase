import fs from "fs";
import path from "path";
import db from "./db";

// Weekly cleanup scan. READ-ONLY: it never deletes anything. It builds a report of candidates
// (stored as a 'pending' cleanup_reports row). The only action is /api/cleanup/delete, which
// archives pages (Trash) and files ONE fix_proposals row for source-file removal.

export type CleanupItem = {
  key: string;
  kind: "orphan_file" | "junk" | "orphan_route" | "empty_page" | "duplicate_page" | "stale_report";
  what: string;
  where: string;
  reason: string;
  safe: boolean;
  unsafe_reason?: string;
};

export const PROTECTED_PAGE_IDS = [263, 315, 308, 361, 373];
export const PROTECTED_TITLE_RE = /resume|cover letter/i;

const ROOT = process.cwd();
const CODE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const ENTRY_NAMES = new Set([
  "page", "layout", "route", "loading", "error", "not-found", "middleware", "instrumentation",
  "global-error", "template", "default", "sitemap", "robots", "manifest",
]);
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
const isTest = (f: string) => /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes("/__tests__/");
const isCode = (f: string) => CODE_EXT.includes(path.extname(f));

function readText(f: string): string {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
}

type Source = { files: string[]; text: Map<string, string> };

function loadSources(): Source {
  const files = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "e2e"))];
  const text = new Map<string, string>();
  for (const f of files) {
    if (isCode(f) || /\.(css|json|md|mdx)$/.test(f)) text.set(f, readText(f));
  }
  return { files, text };
}

function resolveSpec(spec: string, from: string, known: Set<string>): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  const cands = [base, ...CODE_EXT.map((e) => base + e), ...CODE_EXT.map((e) => path.join(base, "index" + e))];
  for (const c of cands) if (known.has(c)) return c;
  return null;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;

/** file -> set of files that import it (all code in src/ and e2e/, tests included as importers). */
function importers(src: Source): Map<string, Set<string>> {
  const known = new Set(src.files.filter(isCode));
  const map = new Map<string, Set<string>>();
  for (const f of known) {
    const t = src.text.get(f) || "";
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(t))) {
      const target = resolveSpec(m[1], f, known);
      if (target && target !== f) {
        if (!map.has(target)) map.set(target, new Set());
        map.get(target)!.add(f);
      }
    }
  }
  return map;
}

function stringRefHits(src: Source, file: string): number {
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  if (base.length < 3) return 1;
  let n = 0;
  for (const [f, t] of src.text) {
    if (f === file) continue;
    if (t.includes(base)) n++;
  }
  return n;
}

function routeUrl(routeFile: string): string {
  const r = rel(routeFile).replace(/^src\/app/, "").replace(/\/route\.[jt]sx?$/, "");
  return r || "/";
}

function routeReferenced(src: Source, routeFile: string): boolean {
  const url = routeUrl(routeFile);
  const needle = url.includes("[") ? url.slice(0, url.indexOf("[")) : url;
  for (const [f, t] of src.text) {
    if (f === routeFile) continue;
    if (t.includes(needle)) return true;
  }
  return false;
}

type PageRow = { id: number; title: string; body: string; parent_id: number | null; kind: string; status: string; updated_at: string };

function loadPages(): PageRow[] {
  return db.prepare(`SELECT id, title, body, parent_id, kind, status, updated_at FROM docs`).all() as PageRow[];
}

/** True if the page (or any ancestor) is protected. Used by the scan AND at delete time. */
export function isProtectedPage(id: number, pages?: PageRow[]): boolean {
  const all = pages || loadPages();
  const byId = new Map(all.map((p) => [p.id, p]));
  let cur = byId.get(id);
  const seen = new Set<number>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (PROTECTED_PAGE_IDS.includes(cur.id) || PROTECTED_TITLE_RE.test(cur.title || "")) return true;
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return false;
}

export function computeItems(): CleanupItem[] {
  const src = loadSources();
  const imp = importers(src);
  const items = new Map<string, CleanupItem>();
  const add = (i: CleanupItem) => {
    if (!items.has(i.key)) items.set(i.key, i);
  };

  // (b) junk
  for (const f of src.files) {
    const r = rel(f);
    if (!(r.startsWith("src/") || r.startsWith("e2e/"))) continue;
    let size = -1;
    try {
      size = fs.statSync(f).size;
    } catch {}
    const junkName = /\.(tmp|bak|orig)$/.test(f) || f.endsWith("~");
    if (junkName || size === 0) {
      add({
        key: `file:${r}`,
        kind: "junk",
        what: path.basename(f),
        where: r,
        reason: size === 0 && !junkName ? "Zero-byte file" : "Temporary/backup file",
        safe: true,
      });
    }
  }

  // (a) orphan source files
  for (const f of src.files) {
    const r = rel(f);
    if (!r.startsWith("src/") || !isCode(f) || isTest(r) || r.endsWith(".d.ts")) continue;
    const name = path.basename(f).replace(/\.[^.]+$/, "");
    if (ENTRY_NAMES.has(name)) continue;
    if (imp.get(f)?.size) continue;
    const hits = stringRefHits(src, f);
    add({
      key: `file:${r}`,
      kind: "orphan_file",
      what: path.basename(f),
      where: r,
      reason: "Nothing imports this file",
      safe: hits === 0,
      ...(hits > 0 ? { unsafe_reason: `Its name appears as text in ${hits} other file(s); may be loaded dynamically` } : {}),
    });
  }

  // (c) orphaned API routes
  for (const f of src.files) {
    const r = rel(f);
    if (!/^src\/app\/api\/.*\/route\.[jt]sx?$/.test(r)) continue;
    if (routeReferenced(src, f)) continue;
    add({
      key: `route:${r}`,
      kind: "orphan_route",
      what: routeUrl(f),
      where: r,
      reason: "No reference to this URL in src/ or e2e/",
      safe: false,
      unsafe_reason: "May be hit by webhooks, cron or external callers",
    });
  }

  // (d) + (e) pages
  const pages = loadPages();
  const active = pages.filter((p) => p.status === "active");
  const hasChild = new Set(active.filter((p) => p.parent_id).map((p) => p.parent_id as number));
  const leaves = active.filter((p) => p.kind === "page" && !hasChild.has(p.id) && !isProtectedPage(p.id, pages));
  const firstByTitle = new Map<string, number>();
  for (const p of [...leaves].sort((a, b) => a.id - b.id)) {
    const t = (p.title || "").trim().toLowerCase();
    if (!firstByTitle.has(t)) firstByTitle.set(t, p.id);
  }
  for (const p of leaves) {
    const t = (p.title || "").trim().toLowerCase();
    if (!(p.body || "").trim()) {
      add({ key: `page:${p.id}`, kind: "empty_page", what: p.title || "(untitled)", where: `Files page ${p.id}`, reason: "Page is empty", safe: true });
    } else if (firstByTitle.get(t) !== p.id) {
      add({
        key: `page:${p.id}`,
        kind: "duplicate_page",
        what: p.title,
        where: `Files page ${p.id}`,
        reason: `Same title as page ${firstByTitle.get(t)}`,
        safe: false,
        unsafe_reason: "Content differs from the original; check before archiving",
      });
    }
  }
  const cutoff = Date.now() - 60 * 86400_000;
  for (const p of active) {
    if (!/report|audit|briefing/i.test(p.title || "")) continue;
    if (isProtectedPage(p.id, pages)) continue;
    const ts = Date.parse(p.updated_at.includes("T") ? p.updated_at : p.updated_at.replace(" ", "T") + "Z");
    if (!Number.isFinite(ts) || ts > cutoff) continue;
    add({
      key: `page:${p.id}`,
      kind: "stale_report",
      what: p.title,
      where: `Files page ${p.id}`,
      reason: `Not touched since ${p.updated_at.slice(0, 10)} (over 60 days)`,
      safe: false,
      unsafe_reason: "Old reports may still be wanted for reference",
    });
  }

  return [...items.values()];
}

export function runScan(): { id: number; items: CleanupItem[] } {
  const items = computeItems();
  let id = 0;
  db.transaction(() => {
    db.prepare(`UPDATE cleanup_reports SET status='superseded' WHERE status='pending'`).run();
    id = Number(db.prepare(`INSERT INTO cleanup_reports (status, items_json) VALUES ('pending', ?)`).run(JSON.stringify(items)).lastInsertRowid);
  })();
  return { id, items };
}

export function latestPending(): { id: number; created_at: string; items: CleanupItem[] } | null {
  const row = db.prepare(`SELECT id, created_at, items_json FROM cleanup_reports WHERE status='pending' ORDER BY id DESC LIMIT 1`).get() as
    | { id: number; created_at: string; items_json: string }
    | undefined;
  if (!row) return null;
  return { id: row.id, created_at: row.created_at, items: JSON.parse(row.items_json || "[]") };
}

/** Re-check at delete time that a file/route candidate is still safe to propose for removal. */
export function recheckFileItem(item: CleanupItem): string | null {
  const abs = path.join(ROOT, item.where);
  const r = rel(abs);
  if (!(r.startsWith("src/") || r.startsWith("e2e/")) || r.includes("..")) return "Path is outside src/ and e2e/";
  if (!fs.existsSync(abs)) return "File no longer exists";
  const src = loadSources();
  if (item.kind === "orphan_file") {
    if (imp_has(src, abs)) return "A file now imports this";
  } else if (item.kind === "orphan_route") {
    if (routeReferenced(src, abs)) return "This URL is now referenced";
  }
  return null;
}

function imp_has(src: Source, abs: string): boolean {
  return (importers(src).get(abs)?.size || 0) > 0;
}
