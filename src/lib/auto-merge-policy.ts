// Decides whether an engineer PR may merge and deploy without Owner. Pure: no I/O, so it is tested directly
// (e2e/auto-merge-policy.spec.ts). It fails closed: anything it can't classify, or can't see (a truncated
// patch, a renamed file, a PR that is too big to read), is held for Owner.
//
// Owner's rules (2026-10-30): never auto-merge anything that sends to someone external or deletes whole
// files; also hold login/security code, new packages, and database changes. Everything else merges.

export type PrFile = {
  filename: string;
  status: string; // GitHub: added | modified | removed | renamed | copied | changed
  additions: number;
  deletions: number;
  patch?: string;
};

export type Verdict = { allow: boolean; reasons: string[] };

export const BRANCH_RE = /^engineer\/fix-\d+$/;
const MAX_FILES = 25;
const MAX_CHANGED_LINES = 1200;

/** Login, security, deploy and the auto-merge machinery itself: a change here must be seen by a person. */
const PROTECTED: RegExp[] = [
  /^src\/lib\/auth\//,
  /^src\/proxy\.ts$/,
  /^src\/lib\/agent-lock\.ts$/,
  /^src\/lib\/job-engine\//,
  /^src\/app\/api\/job-engine\//,
  /^src\/app\/api\/auth\//,
  /^src\/app\/api\/deploy\//,
  /^src\/lib\/(deploy|deploy-stale|disk|backup|pr-builder|ops|auto-merge(-policy|-server)?|pr-conflict-watch|github)\.ts$/,
  /^bridge\//,
  /^\.github\//,
  /^data\//,
  /(^|\/)\.env/,
  /^(next\.config|tsconfig|playwright\.config|eslint\.config)\./,
  /^\.?(claude|agents?)\//,
  /^(CLAUDE|AGENTS)\.md$/,
];

/** New packages pull in outside code. */
const PACKAGES: RegExp[] = [/(^|\/)package(-lock)?\.json$/, /(^|\/)(yarn\.lock|pnpm-lock\.yaml)$/];

/** Database definitions and anything that can destroy rows. */
const DATABASE: RegExp[] = [/^src\/lib\/db\.ts$/, /^src\/lib\/db\//, /migrat/i];

/** Code that talks to people or services outside the OS. Touching it at all is a hold. */
const EXTERNAL: RegExp[] = [
  /^src\/lib\/(mail|mail-tools|mail-accounts|gmail|email-drafts|drafts|drafts-bulk|imessage|delivery|send-plan|text-drafts|outreach|followups|followup-draft|followup-rules|reply-reconcile|gdrive|gcal|gcal-caldav|icloud-caldav|notion|notion-text|voice|inbound-email|email-watchdog|schedule-review|campaign-[a-z-]+|chief-mentions)\.ts$/,
  /^src\/lib\/agents\//,
  /^src\/app\/api\/(email|email-drafts|text-drafts|messages|imessage|mail-accounts|campaigns|outreach|apple|github|notion|calendar|schedule-items|voice|google|chat|agents|runs|ops|issues)\//,
  /^src\/app\/communications\//,
];

type LineRule = { re: RegExp; why: string };

/** Checked against ADDED lines of every file, so a send hidden in an innocent-looking file is still caught. */
const ADDED_LINE_RULES: LineRule[] = [
  { re: /\b(sendMail|createTransport|nodemailer|osascript|ImapFlow)\b/, why: "sends or reads mail/messages" },
  { re: /\bfetch\(\s*(?!["'`]\/(?!\/))/, why: "fetch to something other than this app's own /api" },
  { re: /\b(https?|http2)\.request\(|\bnew WebSocket\(|\bnavigator\.sendBeacon\(/, why: "opens a network connection" },
  { re: /\bchild_process\b|\bexecFile\(|\bexecSync\(|\bspawn(Sync)?\(|\bexec\(/, why: "runs a command" },
  { re: /\b(rmSync|rmdirSync|unlinkSync|rimraf)\b|\bfs(\.promises)?\.(rm|unlink|rmdir)\(/, why: "deletes files at runtime" },
  { re: /\brm\s+-[a-zA-Z]*[rf]/, why: "deletes files with rm" },
  { re: /\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+TABLE\b|\bCREATE\s+TABLE\b/i, why: "changes the database schema or deletes rows" },
  { re: /\bprocess\.env\.[A-Z_]*(PASSWORD|SECRET|TOKEN|KEY)\b/, why: "reads a secret" },
];

function addedLines(patch: string): string[] {
  return patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
}

export function evaluatePr(branch: string, files: PrFile[]): Verdict {
  const reasons: string[] = [];
  const hold = (file: string, why: string) => reasons.push(`${file}: ${why}`);

  if (!BRANCH_RE.test(branch)) return { allow: false, reasons: [`${branch}: not an engineer/fix-N branch`] };
  if (files.length === 0) return { allow: false, reasons: ["no files to review"] };
  if (files.length > MAX_FILES) hold("(whole PR)", `touches ${files.length} files (limit ${MAX_FILES})`);
  const changed = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (changed > MAX_CHANGED_LINES) hold("(whole PR)", `changes ${changed} lines (limit ${MAX_CHANGED_LINES})`);

  for (const f of files) {
    const name = f.filename;
    if (f.status === "removed") hold(name, "deletes the whole file");
    else if (f.status === "renamed" || f.status === "copied" || f.status === "changed") hold(name, `file was ${f.status}`);
    else if (f.status !== "added" && f.status !== "modified") hold(name, `unrecognised status "${f.status}"`);
    if (f.status === "modified" && f.deletions >= 30 && f.additions * 4 < f.deletions) hold(name, `guts the file (${f.deletions} lines removed, ${f.additions} added)`);

    if (PROTECTED.some((re) => re.test(name))) hold(name, "login, security, deploy or auto-merge code");
    if (PACKAGES.some((re) => re.test(name))) hold(name, "changes packages");
    if (DATABASE.some((re) => re.test(name))) hold(name, "database definitions");
    if (EXTERNAL.some((re) => re.test(name))) hold(name, "can send to or change something outside the OS");

    if (f.patch === undefined) {
      if (f.additions + f.deletions > 0) hold(name, "GitHub did not return its diff, so it can't be checked");
      continue;
    }
    for (const line of addedLines(f.patch)) {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("#")) continue; // comments can't do anything
      const rule = ADDED_LINE_RULES.find((r) => r.re.test(line));
      if (rule) {
        hold(name, `${rule.why} (added: ${code.slice(0, 80)})`);
        break;
      }
    }
  }
  return { allow: reasons.length === 0, reasons };
}
