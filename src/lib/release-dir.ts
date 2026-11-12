import fs from "fs";
import path from "path";

export const DEFAULT_ROOT = process.env.OS_ROOT_DIR || "/opt/genlimitless-os";

export type ResolvedRelease = { id: string; dir: string };

/**
 * Resolve the release directory to test, at call time (never cached at boot).
 * No target: follow the 'current' symlink under root. With target: use releases/<target>.
 * Returns null if it cannot be resolved or does not exist.
 */
export function resolveReleaseDir(targetRelease?: string, root: string = DEFAULT_ROOT): ResolvedRelease | null {
  try {
    if (targetRelease) {
      if (!/^[A-Za-z0-9._-]+$/.test(targetRelease)) return null;
      const dir = path.join(root, "releases", targetRelease);
      return fs.existsSync(dir) ? { id: targetRelease, dir } : null;
    }
    const real = fs.realpathSync(path.join(root, "current"));
    return { id: path.basename(real), dir: real };
  } catch {
    return null;
  }
}
