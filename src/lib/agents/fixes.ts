import db from "../db";
import { MIRROR_MODE } from "../imessage";
import { assessRemoval } from "../fix-size-signals";

/** On the server the app runs a production build, so editing files in place does nothing and the edits
 *  vanish on the next deploy. There every code change goes through GitHub (issue -> PR -> merge -> Deploy). */
export function effectiveFixKind(requested: "local" | "github" | undefined, serverMode: boolean = MIRROR_MODE): "local" | "github" {
  return serverMode ? "github" : requested || "local";
}

// Code-change proposals from the Full Stack Engineer. Flow (enforced here, not by prompt):
//   engineer proposes -> pending_cos_review
//   Chief of Staff reviews -> minor: cos_approved (applied automatically)
//                          -> major: pending_approval (Owner's Approve & apply in Analytics)
//                          -> sent_back (engineer revises) | dismissed
// Size is decided by the OS from the files and change text, so an agent can't talk a
// risky change down to "minor". Owner is the only one who can approve a major change.

{
  const cols = (db.prepare(`PRAGMA table_info(fix_proposals)`).all() as { name: string }[]).map((c) => c.name);
  const add = (name: string, ddl: string) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE fix_proposals ADD COLUMN ${ddl}`);
  };
  add("kind", "kind TEXT NOT NULL DEFAULT 'local'"); // local (applied on this Mac) | github (opens an issue for the GitHub coding agent)
  add("size", "size TEXT"); // minor | major
  add("size_reasons", "size_reasons TEXT");
  add("cos_review", "cos_review TEXT");
  add("proposed_by", "proposed_by TEXT");
  add("supersedes", "supersedes INTEGER");
  add("repo", "repo TEXT"); // null = GITHUB_REPO; else an allow-listed demo repo
  add("retry_of", "retry_of INTEGER"); // auto-retry: the failed proposal this one retries
  add("retry_count", "retry_count INTEGER DEFAULT 0");
  add("fail_kind", "fail_kind TEXT"); // usage_limit | transient | policy | typecheck | other
  add("retry_after", "retry_after TEXT"); // ISO time before which an auto-retry must not start
}

// One-time, idempotent: re-issue Owner-approved removal of 5 unused files (supersedes failed #372).
// Still needs his approval click; nothing is removed until then.
{
  try {
    const files = JSON.stringify([
      "src/components/Sidebar.tsx.tmp",
      "src/lib/db.ts.append.tmp",
      "src/components/FileMap.tsx",
      "src/components/SchoolSidebar.tsx",
      "src/components/SenderLine.tsx",
    ]);
    const existing = db
      .prepare(
        `SELECT id FROM fix_proposals WHERE files=? AND proposed_by='cleanup' AND status IN ('pending_approval','applying','sent_to_github','applied') LIMIT 1`
      )
      .get(files);
    if (!existing) {
      db.prepare(
        `INSERT INTO fix_proposals (title, diagnosis, proposed_change, files, status, kind, size, size_reasons, proposed_by, supersedes)
         VALUES (?, ?, ?, ?, 'pending_approval', 'local', 'major', ?, 'cleanup', 372)`
      ).run(
        "Weekly cleanup: remove 5 file(s)",
        "Re-issue of failed #372. Each file is verified unused: FileMap.tsx, SchoolSidebar.tsx and SenderLine.tsx are only referenced by their own definition; the two .tmp files are non-code.",
        "Remove these 5 files with git rm after Owner's approval.",
        files,
        "removes files"
      );
    }
  } catch (e) {
    console.error("cleanup migration failed", e);
  }
}

/** Pre-checks run before a proposal is stored, so a build that can't succeed is never queued. */
export function precheckProposal(input: { files: string[]; proposed_change: string; kind?: "local" | "github" }, serverMode: boolean = MIRROR_MODE): string | null {
  if (!serverMode) return null;
  const bad = input.files.filter((f) => /^(\.\/)?(package(-lock)?\.json|\.github\/)/.test(f));
  if (bad.length) return `The server builder cannot edit these (${bad.join(", ")}); split to a normal PR.`;
  if (input.files.length > 8) return `This touches ${input.files.length} files; split into parts of ≤6 files.`;
  if (mentionsDependencyInstall(input.proposed_change)) return "The server builder cannot add dependencies; split to a normal PR.";
  return null;
}

// Anything touching these is major: how things get sent or approved, the guardrails
// themselves, data and schema, dependencies, and the test/safety harness.
const PROTECTED: RegExp[] = [
  /^src\/lib\/agents\//,
  /^src\/lib\/agent\.ts$/,
  /^src\/lib\/agent-lock\.ts$/,
  /^src\/lib\/ops\.ts$/,
  /^src\/lib\/(delivery|drafts|drafts-bulk|text-drafts|imessage|mail|mail-accounts|mail-tools|send-plan|followups|scheduler|db|backup|data-dir|github|inbound-email|imap-idle)\.ts$/,
  /^src\/app\/api\/(messages|text-drafts|ops|agents|backups|email|mail-accounts)\//,
  /^package(-lock)?\.json$/,
  /^(CLAUDE|AGENTS)\.md$/,
  /^(playwright|next)\.config\.ts$/,
  /^e2e\/(isolated-test|test-cleanup)\.ts$/,
  /^\.github\//,
  /^\.env/,
  /^data\//,
];

const SCHEMA = /\b(CREATE|ALTER|DROP)\s+TABLE\b/i;
const DEPENDENCY = /\b(npm|pnpm|yarn)\s+(install|i|add)\s+[@\w][\w.\/@-]*/i;

/** True when a real install command appears and isn't negated within 40 chars before it. */
function mentionsDependencyInstall(text: string): boolean {
  const re = new RegExp(DEPENDENCY.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!/\b(no|not|without|cannot|can't)\b/i.test(before)) return true;
  }
  return false;
}

export function classifyChange(files: string[], change: string, declared?: "minor" | "major") {
  const reasons: string[] = [];
  if (declared === "major") reasons.push("the engineer marked it major");
  const prot = files.filter((f) => PROTECTED.some((re) => re.test(f.replace(/^\.\//, ""))));
  if (prot.length) reasons.push(`touches protected files: ${prot.join(", ")}`);
  if (files.length > 5) reasons.push(`changes ${files.length} files`);
  const rem = assessRemoval(files, change); if (rem.removes) reasons.push("removes something (file, feature or data)");
  if (SCHEMA.test(change)) reasons.push("changes the database schema");
  if (DEPENDENCY.test(change)) reasons.push("adds a dependency");
  if (change.length > 12_000) reasons.push("large change");
  return { size: reasons.length ? ("major" as const) : ("minor" as const), reasons };
}

export function proposeFix(input: {
  issue_id?: number;
  title: string;
  diagnosis: string;
  proposed_change: string;
  files: string[];
  size?: "minor" | "major";
  kind?: "local" | "github";
  repo?: string;
  proposed_by?: string;
  revises_proposal_id?: number;
}) {
  const dup = db
    .prepare(
      `SELECT id FROM fix_proposals WHERE status IN ('pending_cos_review','pending_approval') AND (issue_id=? OR title=?)`
    )
    .get(input.issue_id ?? -1, input.title);
  if (dup && !input.revises_proposal_id) return { skipped: "a pending proposal for this already exists" };

  const blocked = precheckProposal(input);
  if (blocked) return { rejected: blocked };

  const { size, reasons } = classifyChange(input.files, `${input.diagnosis}\n${input.proposed_change}`, input.size);
  if (input.revises_proposal_id) {
    db.prepare(`UPDATE fix_proposals SET status='superseded' WHERE id=? AND status IN ('sent_back','pending_cos_review','failed')`).run(
      input.revises_proposal_id
    );
  }
  const r = db
    .prepare(
      `INSERT INTO fix_proposals (issue_id, title, diagnosis, proposed_change, files, status, kind, size, size_reasons, proposed_by, supersedes, repo)
       VALUES (?, ?, ?, ?, ?, 'pending_cos_review', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.issue_id ?? null,
      input.title,
      input.diagnosis,
      input.proposed_change,
      JSON.stringify(input.files),
      effectiveFixKind(input.kind),
      size,
      reasons.join("; ") || null,
      input.proposed_by || "full_stack_engineer",
      input.revises_proposal_id ?? null,
      input.repo ?? null
    );
  return {
    proposal_id: Number(r.lastInsertRowid),
    status: "pending_cos_review",
    size,
    size_reasons: reasons,
    note:
      size === "major"
        ? "The Chief of Staff reviews it first; as a major change it then needs Owner's approval."
        : "The Chief of Staff reviews it first; once approved it's applied and tested automatically.",
  };
}

export type FixProposal = {
  id: number;
  issue_id: number | null;
  title: string;
  diagnosis: string;
  proposed_change: string;
  files: string | null;
  repo: string | null;
  status: string;
  result: string | null;
  kind: "local" | "github";
  size: "minor" | "major" | null;
  size_reasons: string | null;
  cos_review: string | null;
  proposed_by: string | null;
  created_at: string;
};

export function getFixProposal(id: number): FixProposal | undefined {
  return db.prepare(`SELECT * FROM fix_proposals WHERE id=?`).get(id) as FixProposal | undefined;
}

export function listFixProposals(limit = 30) {
  return db
    .prepare(
      `SELECT id, title, status, kind, size, size_reasons, cos_review, proposed_by, created_at, substr(result, 1, 400) AS result, fail_kind, retry_of, retry_count FROM fix_proposals ORDER BY id DESC LIMIT ?`
    )
    .all(limit);
}
