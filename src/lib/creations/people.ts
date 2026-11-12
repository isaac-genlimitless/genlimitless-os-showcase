import { ownerName } from "../instance";
import crypto from "crypto";
import db from "../db";
import { OWNER, roleOf, slugify, type Role } from "./store";

// Collaborators on The Creation (Partner first). Each person gets ONE private link (/c/<token>) that opens
// only the creations they're a member of. Only the token's sha256 is stored, so the link is shown once
// when it's made; Owner can make a new one (the old one stops working) or revoke it. Nothing is deleted:
// people are revoked and memberships are marked removed.

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

// Table: creation_people (created with the other creation tables in store.ts, after a backup).

export interface Person { person: string; name: string; status: "active" | "revoked"; has_link: boolean; token_created_at: string | null; last_seen_at: string | null }

function fail(msg: string): never {
  throw new Error(msg);
}

function newToken(): string {
  return crypto.randomBytes(24).toString("base64url"); // 32 chars
}

function creationId(slug: string): number {
  const r = db.prepare(`SELECT id FROM creations WHERE slug = ? AND status = 'active'`).get(slug) as { id: number } | undefined;
  if (!r) fail("creation not found");
  return r.id;
}

function assertOwner(cid: number, actor: string) {
  if (roleOf(cid, actor) !== "owner") fail("only the owner can manage who's on a creation");
}

export function getPerson(person: string): Person | undefined {
  const r = db.prepare(`SELECT person, name, status, token_hash, token_created_at, last_seen_at FROM creation_people WHERE person = ?`).get(person) as
    | (Omit<Person, "has_link"> & { token_hash: string | null })
    | undefined;
  if (!r) return undefined;
  const { token_hash, ...rest } = r;
  return { ...rest, has_link: !!token_hash };
}

/**
 * Add (or re-add) someone to a creation. Returns a fresh link token only when one had to be made
 * (a new person, or one whose link was revoked); otherwise their existing link keeps working.
 */
export function inviteMember(slug: string, input: Record<string, unknown>, actor = OWNER): { person: Person; role: Role; token: string | null } {
  const cid = creationId(slug);
  assertOwner(cid, actor);
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "";
  if (!name) fail("name is required");
  const person = slugify(name).slice(0, 40);
  if (person === OWNER || person === "system" || person === "creation") fail("that name is reserved");
  const role = (input.role === "viewer" ? "viewer" : "collaborator") as Role;
  let token: string | null = null;
  db.transaction(() => {
    const existing = getPerson(person);
    if (!existing) {
      token = newToken();
      db.prepare(`INSERT INTO creation_people (person, name, token_hash, token_created_at) VALUES (?, ?, ?, datetime('now'))`).run(person, name, sha(token));
    } else if (!existing.has_link || existing.status !== "active") {
      token = newToken();
      db.prepare(`UPDATE creation_people SET status='active', token_hash=?, token_created_at=datetime('now') WHERE person = ?`).run(sha(token), person);
    }
    db.prepare(`INSERT INTO creation_members (creation_id, person, role, status) VALUES (?, ?, ?, 'active')
      ON CONFLICT(creation_id, person) DO UPDATE SET role = excluded.role, status = 'active'`).run(cid, person, role);
    db.prepare(`INSERT INTO creation_feed (creation_id, kind, title, actor, resolved_at) VALUES (?, 'member', ?, ?, datetime('now'))`)
      .run(cid, `${name} added as ${role}`, actor);
  })();
  return { person: getPerson(person)!, role, token };
}

/** Take someone off one creation (their link still opens any other creation they're on). */
export function removeMember(slug: string, person: string, actor = OWNER): void {
  const cid = creationId(slug);
  assertOwner(cid, actor);
  if (person === OWNER) fail("the owner can't be removed");
  const r = db.prepare(`UPDATE creation_members SET status='removed' WHERE creation_id = ? AND person = ? AND status = 'active'`).run(cid, person);
  if (!r.changes) fail("member not found");
  db.prepare(`INSERT INTO creation_feed (creation_id, kind, title, actor, resolved_at) VALUES (?, 'member', ?, ?, datetime('now'))`)
    .run(cid, `${getPerson(person)?.name ?? person} removed`, actor);
}

/** Make a new private link (the old one stops working at once). Owner-only: callers must be Owner's session. */
export function regenerateLink(person: string): string {
  if (!getPerson(person)) fail("person not found");
  const token = newToken();
  db.prepare(`UPDATE creation_people SET status='active', token_hash=?, token_created_at=datetime('now') WHERE person = ?`).run(sha(token), person);
  return token;
}

/** Turn someone's link off everywhere. Owner-only. */
export function revokeLink(person: string): void {
  const r = db.prepare(`UPDATE creation_people SET status='revoked', token_hash=NULL WHERE person = ?`).run(person);
  if (!r.changes) fail("person not found");
}

/** Who a private-link token belongs to, or null. Constant-time compare on the hash. */
export function resolveCollabToken(token: string): string | null {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const hash = sha(token);
  const r = db.prepare(`SELECT person, token_hash FROM creation_people WHERE token_hash = ? AND status = 'active'`).get(hash) as { person: string; token_hash: string } | undefined;
  if (!r) return null;
  const a = Buffer.from(r.token_hash);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  db.prepare(`UPDATE creation_people SET last_seen_at = datetime('now') WHERE person = ?`).run(r.person);
  return r.person;
}

export function listMembers(slug: string, actor = OWNER): { person: string; name: string; role: Role; has_link: boolean; last_seen_at: string | null }[] {
  const cid = creationId(slug);
  if (!roleOf(cid, actor)) fail("creation not found");
  return db.prepare(`SELECT m.person, COALESCE(p.name, CASE m.person WHEN 'owner' THEN ? ELSE m.person END) AS name, m.role,
      (p.token_hash IS NOT NULL) AS has_link, p.last_seen_at
    FROM creation_members m LEFT JOIN creation_people p ON p.person = m.person
    WHERE m.creation_id = ? AND m.status = 'active' ORDER BY m.role = 'owner' DESC, m.person`).all(ownerName(), cid) as never;
}
