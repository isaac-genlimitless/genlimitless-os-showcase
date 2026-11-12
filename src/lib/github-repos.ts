// Which GitHub repos the engineering pipeline may touch: the OS's own repo plus an explicit allowlist.
export function allowedRepos(env = process.env): string[] {
  const main = env.GITHUB_REPO ? [env.GITHUB_REPO] : [];
  const extra = (env.GITHUB_EXTRA_REPOS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...main, ...extra])];
}

/** The repo to use: the default when none is given; throws if the given one isn't allow-listed. */
export function resolveRepo(repo?: string | null, env = process.env): string {
  const list = allowedRepos(env);
  if (!repo) {
    if (!env.GITHUB_REPO) throw new Error("GITHUB_REPO isn't set in .env.local — the repo hasn't been connected yet.");
    return env.GITHUB_REPO;
  }
  if (!list.includes(repo)) throw new Error(`Repo ${repo} isn't allowed. Allowed: ${list.join(", ") || "(none)"}. Owner adds repos via GITHUB_EXTRA_REPOS in .env.local.`);
  return repo;
}
