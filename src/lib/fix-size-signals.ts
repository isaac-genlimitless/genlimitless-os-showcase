// Decides whether a proposed change really removes something. Pure; no db, no network.
// Same regex as the old fixes.ts DESTRUCTIVE (kept as the prose/fallback detector).
export const DESTRUCTIVE = /\b(delete|remove|rm|unlink|drop|truncate|wipe)\b[^.\n]{0,60}\b(file|files|table|column|row|rows|feature|route|page|component|data|database)\b/i;
const NEGATION = /\b(no|never|not|without|nothing|don'?t|do not|cannot|can'?t)\b/i;
const LEAD = String.raw`(?:^|[\s;&|\`(])`;

// Explicit signals: ALWAYS a real deletion. Negation words nearby are deliberately ignored.
const EXPLICIT: RegExp[] = [
  new RegExp(LEAD + String.raw`git\s+rm\s+\S`, "im"),
  new RegExp(LEAD + String.raw`rm\s+(?:-[a-z]+\s+)+\S`, "im"), // rm -rf x
  new RegExp(LEAD + String.raw`rm\s+(?!-)\S*[\/.]\S*`, "im"), // rm src/a.ts  (not "rm the old file")
  new RegExp(LEAD + String.raw`unlink\s+\S*[\/.]\S*`, "im"),
  /\bfs\.(?:promises\.)?unlink(?:Sync)?\s*\(/,
  /^deleted file mode\b/m,
  /^DELETE FILE:\s*\S+/im,
];

// Evidence in the files list / diff that a file is really being removed (used with the prose fallback).
const FILE_LIST_REMOVAL = [/^(?:delete[d]?|remove[d]?)\s*[:\s]\s*\S/i, /^D\s+\S/, /\s\((?:deleted|removed)\)\s*$/i];
const DIFF_REMOVAL = /^\+\+\+ \/dev\/null\s*$/m;

export function hasExplicitDeletion(change: string): boolean {
  return EXPLICIT.some((re) => re.test(change));
}

export function hasRemovalEvidence(files: string[], change: string): boolean {
  return files.some((f) => FILE_LIST_REMOVAL.some((re) => re.test(f.trim()))) || DIFF_REMOVAL.test(change);
}

/** any = the old regex matched somewhere; unexempted = at least one match has no negation word in the 40 chars before it. */
export function proseRemoval(change: string): { any: boolean; unexempted: boolean } {
  const re = new RegExp(DESTRUCTIVE.source, "gi");
  let any = false, unexempted = false, m: RegExpExecArray | null;
  while ((m = re.exec(change))) {
    any = true;
    if (!NEGATION.test(change.slice(Math.max(0, m.index - 40), m.index))) unexempted = true;
  }
  return { any, unexempted };
}

/** true => classifyChange adds the "removes something" major reason. */
export function assessRemoval(files: string[], change: string): { removes: boolean; why: string } {
  if (hasExplicitDeletion(change)) return { removes: true, why: "explicit file removal (git rm / rm / unlink / deleted-file diff)" };
  const p = proseRemoval(change);
  if (p.unexempted) return { removes: true, why: "removes something (file, feature or data)" };
  if (p.any && hasRemovalEvidence(files, change)) return { removes: true, why: "removal wording plus a removed file in the files list or diff" };
  return { removes: false, why: "" };
}
