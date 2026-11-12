import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

// After a deploy, phones can still hold a page from the previous build (iOS keeps the home-screen app and
// Safari tabs alive in memory). That page loads JS/CSS chunks by their hashed names, and nginx serves those
// only from the live release (bridge/nginx-os-genlimitless.conf: /_next/static -> current/.next/static).
// So at startup, copy the previous release's hashed files that this build doesn't have. Hashed names never
// collide with different content; files older than KEEP_DAYS are skipped so this can't grow forever.
// Async and best-effort: never blocks the server, never throws.
const KEEP_DAYS = 14;

export async function keepPreviousStatic(opts: { root?: string; cwd?: string; now?: number } = {}): Promise<number> {
  const root = opts.root ?? "/opt/genlimitless-os";
  const cwd = opts.cwd ?? process.cwd();
  try {
    const [cur, here, prev] = await Promise.all([
      fs.realpath(path.join(root, "current")).catch(() => null),
      fs.realpath(cwd).catch(() => null),
      fs.realpath(path.join(root, "previous")).catch(() => null),
    ]);
    if (!cur || !here || !prev || cur !== here || prev === here) return 0; // only the live release, only when there is an older one
    const src = path.join(prev, ".next", "static");
    const dst = path.join(here, ".next", "static");
    await fs.access(src); await fs.access(dst);
    const cutoff = (opts.now ?? Date.now()) - KEEP_DAYS * 86_400_000;
    let copied = 0;
    const walk = async (rel: string): Promise<void> => {
      for (const e of await fs.readdir(path.join(src, rel), { withFileTypes: true })) {
        const r = path.join(rel, e.name);
        if (e.isDirectory()) { await walk(r); continue; }
        if (!e.isFile()) continue;
        const from = path.join(src, r), to = path.join(dst, r);
        const st = await fs.stat(from);
        if (st.mtimeMs < cutoff) continue;
        if (await fs.access(to).then(() => true, () => false)) continue;
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to, constants.COPYFILE_EXCL).catch(() => {});
        await fs.utimes(to, st.atime, st.mtime).catch(() => {}); // keep the original age for the cutoff
        copied++;
      }
    };
    await walk(".");
    if (copied) console.log(`[keep-previous-static] kept ${copied} page files from ${path.basename(prev)} for phones still on it`);
    return copied;
  } catch (e: any) {
    console.warn("[keep-previous-static] skipped:", e?.message || e);
    return 0;
  }
}
