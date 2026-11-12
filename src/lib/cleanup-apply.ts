import fs from "fs";
import path from "path";

type Run = (cmd: string, args: string[], cwd: string, timeout?: number) => Promise<{ ok: boolean; out: string }>;

export type CleanupResult = { removed: string[]; refused: { file: string; reason: string }[] };

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs)$/;
const PROTECTED = [
  /(^|\/)db\.ts$/,
  /(^|\/)agent-lock\.ts$/,
  /(^|\/)middleware\.[jt]s$/,
  /^\.github\//,
  /^src\/app\/.*(^|\/)(page|route|layout)\.(ts|tsx|js|jsx)$/,
];

function walk(root: string, out: string[] = []): string[] {
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".next") continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (CODE_EXT.test(e.name)) out.push(p);
  }
  return out;
}

function specifiers(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) specs.push(m[1]);
  return specs;
}

/** Absolute paths (extension stripped) that a file imports, for relative and '@/' specifiers. */
function importedBases(dir: string, file: string): string[] {
  const out: string[] = [];
  for (const s of specifiers(fs.readFileSync(file, "utf8"))) {
    if (s.startsWith("@/")) out.push(path.join(dir, "src", s.slice(2)));
    else if (s.startsWith(".")) out.push(path.resolve(path.dirname(file), s));
  }
  return out.map((b) => b.replace(CODE_EXT, ""));
}

/** Removes only the listed files (already approved by Owner) with `git rm`, each behind strict guards. */
export async function removeCleanupFiles(dir: string, files: string[], run: Run): Promise<CleanupResult> {
  const removed: string[] = [];
  const refused: { file: string; reason: string }[] = [];
  const root = path.resolve(dir);
  let importMap: Map<string, string[]> | null = null;

  for (const raw of files) {
    const file = typeof raw === "string" ? raw.trim() : "";
    const no = (reason: string) => refused.push({ file: String(raw), reason });
    if (!file) { no("empty path"); continue; }
    if (path.isAbsolute(file) || file.startsWith("/") || /^[a-zA-Z]:/.test(file)) { no("not a relative path"); continue; }
    if (file.split(/[\\/]/).includes("..")) { no("contains '..'"); continue; }
    if (!(file.startsWith("src/") || file.startsWith("e2e/"))) { no("not under src/ or e2e/"); continue; }
    if (PROTECTED.some((re) => re.test(file))) { no("protected path"); continue; }
    const abs = path.resolve(root, file);
    if (!abs.startsWith(root + path.sep)) { no("resolves outside the working copy"); continue; }
    const tracked = await run("git", ["ls-files", "--error-unmatch", "--", file], root, 60_000);
    if (!tracked.ok) { no("not tracked by git"); continue; }
    if (/\.(ts|tsx|js)$/.test(file)) {
      if (!importMap) {
        importMap = new Map();
        for (const f of [...walk(path.join(root, "src")), ...walk(path.join(root, "e2e"))]) importMap.set(f, importedBases(root, f));
      }
      const base = abs.replace(CODE_EXT, "");
      const importer = [...importMap.entries()].find(
        ([f, bases]) => f !== abs && bases.some((b) => b === base || b === abs || (path.basename(base) === "index" && b === path.dirname(base)))
      );
      if (importer) { no(`still imported by ${path.relative(root, importer[0])}`); continue; }
    }
    const rm = await run("git", ["rm", "-q", "--", file], root, 60_000);
    if (!rm.ok) { no(`git rm failed: ${rm.out.slice(-200)}`); continue; }
    removed.push(file);
  }
  return { removed, refused };
}
