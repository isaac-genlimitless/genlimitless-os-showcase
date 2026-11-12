// Shared lockdown for every agent the OS runs.
//
// Agents read untrusted content (web pages, and now emails from strangers), so they run as a
// strict allowlist: `dontAsk` denies anything not explicitly approved (instead of
// `bypassPermissions`, which allowed everything), only the built-in tools listed in `tools`
// exist, and `strictMcpConfig` stops the account's claude.ai connectors (Gmail send, Drive,
// Calendar, Notion...) from loading. Result: no path to send mail, delete anything, or reach
// outside the OS except through the OS's own approval-gated tools.

/** Files no agent may read, even though agents may read the repo to diagnose bugs. */
export const SECRET_READ_DENY = [
  "Read(./.env*)",
  "Read(./**/.env*)",
  "Read(./.git/**)",
  "Read(./data/google-token.json)",
  "Read(./data/*.db*)",
  "Read(./data/*.log)",
  "Read(./data/*.key)",
  "Read(./data/**/*.db*)",
  "Read(./data/AUTH_DISABLED)",
  // Server layout: releases symlink data/ and .env.local into /opt/genlimitless-os/shared.
  "Read(//opt/genlimitless-os/shared/.env*)",
  "Read(//opt/genlimitless-os/shared/data/*.key)",
  "Read(//opt/genlimitless-os/shared/data/**/*.db*)",
  "Read(//opt/genlimitless-os/shared/data/*.log)",
  "Read(//opt/genlimitless-os/backups/**)",
  "Read(//opt/genlimitless-os/repo.git/**)",
  // Multi-user cells: other users' data, the shared accounts db + auth secret, per-user env files (tokens).
  "Read(//opt/genlimitless-os/users/**)",
  "Read(//opt/genlimitless-os/shared/accounts/**)",
  "Read(//etc/glos/**)",
  "Read(//proc/**)",
  "Read(//root/**)",
  // Outside the project: credentials, shell history/config, the Messages database, system files.
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Read(~/.config/**)",
  "Read(~/.gnupg/**)",
  "Read(~/.claude/**)",
  "Read(~/.genlimitless-agent/**)",
  "Read(~/Library/**)",
  "Read(~/.zsh*)",
  "Read(~/.bash*)",
  "Read(~/.netrc)",
  "Read(~/.gitconfig)",
  "Read(~/Documents/**)",
  "Read(~/Desktop/**)",
  "Read(~/Downloads/**)",
  "Read(//etc/**)",
  "Read(//private/etc/**)",
];

/** Extra denies for the agent that's allowed to edit code (after Owner approves a fix). */
export const CODE_WRITE_DENY = [
  "Edit(./.env*)",
  "Write(./.env*)",
  "Edit(./data/**)",
  "Write(./data/**)",
  "Edit(./.git/**)",
  "Write(./.git/**)",
  "Edit(./.github/**)",
  "Write(./.github/**)",
  "Edit(//opt/genlimitless-os/shared/**)",
  "Write(//opt/genlimitless-os/shared/**)",
  "Edit(//opt/genlimitless-os/backups/**)",
  "Write(//opt/genlimitless-os/backups/**)",
  "Edit(//opt/genlimitless-os/repo.git/**)",
  "Write(//opt/genlimitless-os/repo.git/**)",
];

export const LOCKED_BASE = {
  strictMcpConfig: true,
  settingSources: [] as never[],
  permissionMode: "dontAsk" as const,
};
