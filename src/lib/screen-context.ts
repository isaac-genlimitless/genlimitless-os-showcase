import fs from "fs";
import path from "path";

// What Owner's screen holds, kept OUT of the prompt. The chat sends the page text along with each
// message; it is stashed here and only enters Chief's context if he calls read_current_screen.
// globalThis, so the chat route and the agent's tools share one copy whatever the bundling does.
type Snap = { url: string; text: string; captured_at: string };
const KEY = Symbol.for("genlimitless.screenSnapshot");
const g = globalThis as unknown as Record<symbol, Snap | undefined>;

export const SCREEN_STASH_MAX = 60000;

export function stashScreen(url: unknown, text: unknown) {
  if (typeof text !== "string" || !text.trim()) {
    g[KEY] = undefined;
    return;
  }
  g[KEY] = { url: typeof url === "string" ? url.slice(0, 300) : "", text: text.slice(0, SCREEN_STASH_MAX), captured_at: new Date().toISOString() };
}

export function readScreen(): Snap | null {
  return g[KEY] ?? null;
}

const IMPORT_RE = /from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const API_RE = /["'`](\/api\/[A-Za-z0-9_\-/\[\]]*)/g;

function resolveSrc(root: string, spec: string, fromFile: string): string | null {
  const base = spec.startsWith("@/") ? path.join(root, "src", spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(fromFile), spec) : null;
  if (!base) return null;
  for (const c of [base, ...[".tsx", ".ts"].map((e) => base + e), ...[".tsx", ".ts"].map((e) => path.join(base, "index" + e))]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.relative(root, c);
  }
  return null;
}

/** Source files behind a route: the page, its local imports, and the API routes it calls. Read-only. */
export function routeSourceFiles(pathname: string, root = process.cwd()) {
  const clean = "/" + pathname.split(/[?#]/)[0].split("/").filter(Boolean).join("/");
  const dir = path.join(root, "src", "app", clean === "/" ? "" : clean);
  if (!path.resolve(dir).startsWith(path.join(root, "src", "app"))) return { route: clean, page: null, files: [], api_routes: [] };
  const pageFile = ["page.tsx", "page.ts"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!pageFile) return { route: clean, page: null, files: [], api_routes: [] };
  const files = new Set<string>([path.relative(root, pageFile)]);
  const apis = new Set<string>();
  // Siblings in the route folder (panels, client components) plus one level of local imports.
  const queue = [pageFile, ...fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(dir, f))];
  for (const f of queue) {
    files.add(path.relative(root, f));
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const r = resolveSrc(root, m[1] || m[2], f);
      if (r) files.add(r);
    }
    for (const m of src.matchAll(API_RE)) apis.add(m[1].replace(/\/+$/, ""));
  }
  const apiFiles = [...apis].map((a) => path.join("src", "app", a, "route.ts")).filter((p) => fs.existsSync(path.join(root, p)));
  return { route: clean, page: path.relative(root, pageFile), files: [...files].sort(), api_routes: [...apis].sort(), api_route_files: apiFiles };
}
