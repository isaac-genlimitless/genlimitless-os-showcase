// Read-only scanner: maps backend source files (src/**) and their imports.
import fs from "fs";
import path from "path";

export type CodeMapNode = {
  id: string;
  label: string;
  dir: string;
  role: string;
  purpose: string;
  lines: number;
  imports: string[];
  importedBy: string[];
  external: string[];
};
export type CodeMap = {
  generatedAt: string;
  counts: { files: number; edges: number; external: number };
  nodes: CodeMapNode[];
  edges: { s: string; t: string }[];
};

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "data"]);
const MAX_FILES = 2000;
const MAX_BYTES = 1024 * 1024;
const TTL_MS = 30_000;

let cache: { at: number; value: CodeMap } | null = null;

function skipFile(name: string): boolean {
  if (name.startsWith(".env")) return true;
  if (/(secret|credential|\.pem|\.key)$/i.test(name)) return true;
  if (/\.tmp$/i.test(name) || name.endsWith(".append.tmp")) return true;
  return false;
}

function walk(root: string, out: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (e.isFile()) {
      if (skipFile(e.name)) continue;
      if (!EXTS.includes(path.extname(e.name))) continue;
      out.push(full);
    }
  }
}

function roleOf(id: string): string {
  const base = path.posix.basename(id);
  if (/\.test\.[a-z]+$/.test(base)) return "tests";
  if (id.startsWith("src/app/api/")) return "api";
  if (id.startsWith("src/app/")) return "ui-page";
  if (id.startsWith("src/components/")) return "ui-component";
  if (id === "src/lib/agents/tools.ts" || /-tools\.[a-z]+$/.test(base)) return "tools";
  if (id.startsWith("src/lib/agents/")) return "agents";
  if (/^(db|data-dir|backup|undo|audit)\b/.test(base)) return "db";
  if (/^(gmail|gcal|gdrive|notion|plaid|snaptrade|github|icloud|caldav|imap|mail|linkedin)/.test(base)) return "integrations";
  if (id.startsWith("src/lib/")) return "core";
  return "other";
}

function humanize(file: string): string {
  const base = file.replace(/\.[a-z]+$/, "").replace(/[-_.]+/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function purposeOf(text: string, id: string, role: string): string {
  let p = "";
  for (const raw of text.split("\n").slice(0, 40)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("//")) p = line.replace(/^\/\/+\s*/, "");
    else if (line.startsWith("/*")) {
      p = line.replace(/^\/\*+\s*/, "").replace(/\*\/\s*$/, "").trim();
      if (!p) continue;
    } else if (line.startsWith("*") && false) p = "";
    break;
  }
  if (!p) {
    // block comment with first content on a later line
    const m = text.trimStart().match(/^\/\*+\s*\n?\s*\*?\s*([^\n*][^\n]*)/);
    if (m) p = m[1].replace(/\*\/\s*$/, "").trim();
  }
  if (!p || /^["']use (client|server)["']/.test(p)) {
    return `${humanize(path.posix.basename(id))} (${role})`;
  }
  p = p.replace(/(sk-|ghp_|xox|AKIA)[A-Za-z0-9_-]{8,}/g, "[redacted]");
  return p.length > 140 ? p.slice(0, 140) : p;
}

const IMPORT_RES = [
  /\bimport\s+(?:type\s+)?[^"'`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bexport\s+[^"'`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

export function buildCodeMap(): CodeMap {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const cwd = process.cwd();
  const files: string[] = [];
  walk(path.join(cwd, "src"), files);
  const toId = (abs: string) => path.relative(cwd, abs).split(path.sep).join("/");
  const idSet = new Set(files.map(toId));

  const resolveId = (base: string): string | null => {
    if (idSet.has(base)) return base;
    for (const x of RESOLVE_EXTS) if (idSet.has(base + x)) return base + x;
    for (const x of RESOLVE_EXTS) if (idSet.has(base + "/index" + x)) return base + "/index" + x;
    return null;
  };

  const nodes = new Map<string, CodeMapNode>();
  const edges: { s: string; t: string }[] = [];
  const edgeSeen = new Set<string>();

  for (const abs of files) {
    const id = toId(abs);
    let text = "";
    try {
      if (fs.statSync(abs).size > MAX_BYTES) continue;
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const role = roleOf(id);
    const node: CodeMapNode = {
      id,
      label: path.posix.basename(id),
      dir: path.posix.dirname(id),
      role,
      purpose: purposeOf(text, id, role),
      lines: text.split("\n").length,
      imports: [],
      importedBy: [],
      external: [],
    };
    const ext = new Set<string>();
    const targets = new Set<string>();
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    for (const src of [text, stripped]) for (const re of IMPORT_RES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const spec = m[1];
        let resolved: string | null = null;
        if (spec.startsWith("@/")) resolved = resolveId("src/" + spec.slice(2));
        else if (spec.startsWith(".")) resolved = resolveId(path.posix.join(node.dir, spec));
        else if (spec.startsWith("node:")) continue;
        else {
          const parts = spec.split("/");
          ext.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
          continue;
        }
        if (resolved && resolved !== id) targets.add(resolved);
      }
    }
    node.imports = [...targets].sort();
    node.external = [...ext].sort();
    for (const t of node.imports) {
      const k = id + "->" + t;
      if (!edgeSeen.has(k)) {
        edgeSeen.add(k);
        edges.push({ s: id, t });
      }
    }
    nodes.set(id, node);
  }
  for (const e of edges) nodes.get(e.t)?.importedBy.push(e.s);
  for (const n of nodes.values()) n.importedBy.sort();

  const list = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const value: CodeMap = {
    generatedAt: new Date().toISOString(),
    counts: {
      files: list.length,
      edges: edges.length,
      external: new Set(list.flatMap((n) => n.external)).size,
    },
    nodes: list,
    edges,
  };
  cache = { at: Date.now(), value };
  return value;
}
