// A deploy that says "running" but hasn't updated in 30 minutes was killed mid-build
// (every phase rewrites `at`; the longest allowed phase is 20 min). Read it as failed.
export const STALE_RUNNING_MS = 30 * 60 * 1000;

export function staleAware<T extends { state: string; message: string; sha: string; at: string }>(
  s: T | null,
  now: number = Date.now(),
): T | null {
  if (!s || s.state !== "running") return s;
  const t = Date.parse(s.at);
  if (!isFinite(t) || now - t < STALE_RUNNING_MS) return s;
  return {
    ...s,
    state: "failed",
    message: `The deploy stopped unexpectedly after "${s.message}" (no progress for ${Math.round((now - t) / 60000)} min, probably the build was killed). Nothing changed on the live site. Click Deploy to try again.`,
  };
}
