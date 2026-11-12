// Who this process (cell) belongs to. No imports, no database: safe to load anywhere (proxy, config, tests).
export const DEFAULT_USER = "owner";

/** GLOS_USER (slug). Unset means the single-user setup: owner. */
export function currentUserId(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env.GLOS_USER || "").trim().toLowerCase();
  return v || DEFAULT_USER;
}

/** Only the legacy single-process setup (GLOS_USER unset or owner) may run open while its user has not enrolled.
 *  Any other cell always requires a session. */
export function mayRunOpenWhenUnenrolled(env: NodeJS.ProcessEnv = process.env): boolean {
  return currentUserId(env) === DEFAULT_USER;
}

/** Fail closed: this cell holds accounts.db and the auth secret only if GLOS_ROLE is exactly "owner", or if both
 *  GLOS_USER and GLOS_ROLE are unset (the single-user setup). Every other cell (members) must never open them:
 *  it asks the owner cell over loopback who a session belongs to. */
export function ownsAccounts(env: NodeJS.ProcessEnv = process.env): boolean {
  const role = (env.GLOS_ROLE || "").trim();
  if (role) return role === "owner";
  return !(env.GLOS_USER || "").trim();
}

export function assertOwnsAccounts(what: string): void {
  if (!ownsAccounts()) throw new Error(`${what} is only available in the owner cell (this is a member cell)`);
}
