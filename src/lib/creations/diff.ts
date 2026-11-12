// Pure diff / apply / rebase logic for canon vs. sandboxes. No database, no I/O.
import type { Artifact, Change } from "./types";

function same(a: Artifact | undefined, b: Artifact | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.title === b.title && a.body === b.body && JSON.stringify(a.data ?? null) === JSON.stringify(b.data ?? null);
}

const byKey = (list: Artifact[]) => new Map(list.map((a) => [a.key, a]));

/** What the sandbox changed relative to the version it was forked from. `current` (canon now) marks conflicts. */
export function diffArtifacts(base: Artifact[], sandbox: Artifact[], current?: Artifact[]): Change[] {
  const b = byKey(base);
  const s = byKey(sandbox);
  const c = current ? byKey(current) : null;
  const changes: Change[] = [];
  for (const art of sandbox) {
    const prev = b.get(art.key);
    if (!prev) changes.push({ op: "add", key: art.key, title: art.title, before: null, after: art });
    else if (!same(prev, art)) changes.push({ op: "change", key: art.key, title: art.title, before: prev, after: art });
  }
  for (const art of base) {
    if (!s.has(art.key)) changes.push({ op: "remove", key: art.key, title: art.title, before: art, after: null });
  }
  if (c) {
    for (const ch of changes) {
      const now = c.get(ch.key);
      const was = b.get(ch.key);
      if (!same(now, was)) ch.conflict = true;
    }
  }
  return changes;
}

/** Apply a sandbox's changes on top of the current canon (artifact-level; order kept, adds appended). */
export function applyChanges(current: Artifact[], changes: Change[]): Artifact[] {
  const out = current.map((a) => ({ ...a }));
  for (const ch of changes) {
    const i = out.findIndex((a) => a.key === ch.key);
    if (ch.op === "remove") {
      if (i >= 0) out.splice(i, 1);
    } else if (ch.after) {
      if (i >= 0) out[i] = { ...ch.after };
      else out.push({ ...ch.after });
    }
  }
  return out;
}

/**
 * Move a sandbox onto a newer canon: artifacts the sandbox didn't touch take canon's new content;
 * artifacts it did touch keep the sandbox's version. Returns the sandbox's new artifact list.
 */
export function rebaseArtifacts(oldBase: Artifact[], sandbox: Artifact[], newBase: Artifact[]): Artifact[] {
  const own = diffArtifacts(oldBase, sandbox);
  return applyChanges(newBase, own);
}
