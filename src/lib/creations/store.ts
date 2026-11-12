import { isOwnerCell, ownerName } from "../instance";
import db from "../db";
import { applyChanges, diffArtifacts, rebaseArtifacts } from "./diff";
import { SEED_CREATIONS, SEED_PROPOSALS } from "./seed";
import { normalizeInputs } from "./models/site-pnl";
import { normalizeMap } from "./models/structure-map";
import { normalizePlan } from "./models/site-plan";
import { normalizeSites } from "./models/site-finder";
import {
  ARTIFACT_KINDS, PHASES,
  type Artifact, type ArtifactKind, type Change, type CreationDetail, type CreationSummary, type FeedItem,
  type PhaseKey, type PromotionRow, type SandboxDetail, type SandboxRow, type Snapshot, type VersionRow,
} from "./types";

// The Creation: canon (the real thing) vs. sandboxes (where anything can be built).
//
// Canon is never edited in place. It only changes when the owner approves a promotion from a
// sandbox, which writes a NEW version row; every past version stays readable. Sandboxes and
// artifacts are archived, never deleted. There is deliberately no delete function in this file.
//
// Nothing here talks to Notion, email, or anything outside this database.

export const OWNER = "owner";
const MAX_BODY = 200_000;
const MAX_DATA = 500_000;
const RESERVED_SLUGS = new Set(["sandboxes", "promotions", "versions", "new", "people", "feed", "site3d", "api", "members", "comments", "missions", "budget", "steps"]);
/** Actors that are not people: starter material. They never hold canon rights. */
const SYSTEM_ACTORS = new Set(["system"]);
/** Creation-team agents act as "agent:<role>". They work only inside their own sandboxes and can never change canon. */
export const isAgentActor = (actor: string) => /^agent:[a-z_]{2,30}$/.test(actor);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '✨',
  phase TEXT NOT NULL DEFAULT 'vision',
  canon_version_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',          -- active | archived
  created_by TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS creation_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creation_id INTEGER NOT NULL REFERENCES creations(id),
  number INTEGER NOT NULL,
  snapshot TEXT NOT NULL,                          -- JSON Snapshot; immutable once written
  note TEXT NOT NULL DEFAULT '',
  promotion_id INTEGER,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (creation_id, number)
);
CREATE TABLE IF NOT EXISTS creation_sandboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creation_id INTEGER NOT NULL REFERENCES creations(id),
  base_version_id INTEGER NOT NULL REFERENCES creation_versions(id),
  owner_kind TEXT NOT NULL DEFAULT 'person',       -- person | agent
  owner TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',           -- active | archived
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS creation_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sandbox_id INTEGER NOT NULL REFERENCES creation_sandboxes(id),
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  data TEXT,                                       -- JSON
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',           -- active | archived
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sandbox_id, key)
);
CREATE TABLE IF NOT EXISTS creation_promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creation_id INTEGER NOT NULL REFERENCES creations(id),
  sandbox_id INTEGER NOT NULL REFERENCES creation_sandboxes(id),
  base_version_id INTEGER NOT NULL,
  changes TEXT NOT NULL,                           -- JSON Change[]
  rationale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | approved | declined | superseded
  proposed_by TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  result_version_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS creation_feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creation_id INTEGER NOT NULL REFERENCES creations(id),
  kind TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  ref_type TEXT,
  ref_id INTEGER,
  actor TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS creation_members (
  creation_id INTEGER NOT NULL REFERENCES creations(id),
  person TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',             -- owner | collaborator | viewer
  status TEXT NOT NULL DEFAULT 'active',           -- active | removed
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (creation_id, person)
);
CREATE TABLE IF NOT EXISTS creation_people (
  person TEXT PRIMARY KEY,                         -- slug used as the actor name, e.g. "partner"
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE,                          -- sha256 of their private link token; NULL when revoked
  status TEXT NOT NULL DEFAULT 'active',           -- active | revoked
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  token_created_at TEXT,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS creation_missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creation_id INTEGER NOT NULL REFERENCES creations(id),
  sandbox_id INTEGER,                              -- the agent's own sandbox (made when the mission starts)
  role TEXT NOT NULL,                              -- inventor | researcher | modeler | architect | skeptic
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',           -- queued | running | done | stopped | failed | cancelled
  budget_tokens INTEGER NOT NULL,                  -- this mission's ceiling (always within the rolling 1M cap)
  used_tokens INTEGER NOT NULL DEFAULT 0,
  run_id INTEGER,                                  -- agent_runs row (Activity page)
  report TEXT,
  stop_reason TEXT,
  started_by TEXT NOT NULL,
  scheduled_for TEXT,                              -- UTC 'YYYY-MM-DD HH:MM:SS'; NULL = as soon as possible
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS creation_token_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER NOT NULL,
  tokens INTEGER NOT NULL,                         -- every billed token: input + output + cache read + cache write
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_creation_ledger_at ON creation_token_ledger(at);
CREATE INDEX IF NOT EXISTS idx_creation_missions ON creation_missions(status, scheduled_for);
CREATE TABLE IF NOT EXISTS creation_exec_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creation_id INTEGER NOT NULL REFERENCES creations(id),
  version_id INTEGER,                              -- the canon version the step was planned from
  kind TEXT NOT NULL,                              -- task | email | meeting | manual
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  payload TEXT,                                    -- JSON: email {to, subject, body, account?}; meeting {start, end, attendees?}; task {due_date?, priority?}
  status TEXT NOT NULL DEFAULT 'proposed',         -- proposed | approved | done | declined | failed
  result TEXT,                                     -- what approving did (task id, draft id, approval request id) or the error
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  decided_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS creation_seed_log (
  name TEXT PRIMARY KEY,                           -- a one-time starter proposal that has been queued
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_creation_feed ON creation_feed(creation_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_creation_sandboxes ON creation_sandboxes(creation_id, status);
CREATE INDEX IF NOT EXISTS idx_creation_promotions ON creation_promotions(creation_id, status);
`;

let ready: Promise<void> | null = null;

/** Creates the tables on first use (after a fresh backup) and seeds the day-one creations. Additive only. */
export function ensureCreationsSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='creations'`).get();
      if (!exists) {
        try {
          const { backupDatabase } = await import("../backup");
          await backupDatabase();
        } catch {
          /* backupDatabase logs its own failures; this change only adds new tables */
        }
      }
      db.exec(SCHEMA);
      // The starter canon and proposals are Owner's own project material: owner cell only. A member's Creation starts empty.
      for (const s of isOwnerCell() ? SEED_CREATIONS : []) {
        if (!db.prepare(`SELECT 1 FROM creations WHERE slug = ?`).get(s.slug)) {
          createCreationRaw({ slug: s.slug, title: s.title, tagline: s.tagline, icon: s.icon, phase: s.phase }, s.artifacts, "system", "Starting canon");
        }
      }
      // New starter material never goes straight into canon: it arrives as a proposal Owner approves.
      for (const p of isOwnerCell() ? SEED_PROPOSALS : []) {
        if (db.prepare(`SELECT 1 FROM creation_seed_log WHERE name = ?`).get(p.name)) continue;
        if (!db.prepare(`SELECT 1 FROM creations WHERE slug = ? AND status = 'active'`).get(p.slug)) continue;
        db.transaction(() => {
          const sb = createSandbox(p.slug, { title: p.sandboxTitle }, "system", "agent");
          for (const a of p.artifacts) saveArtifact(sb.id, { ...a }, "system");
          proposePromotion(sb.id, { rationale: p.rationale }, "system");
          db.prepare(`INSERT INTO creation_seed_log (name) VALUES (?)`).run(p.name);
        })();
      }
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

// ---------- helpers ----------

function fail(msg: string): never {
  throw new Error(msg);
}

function str(v: unknown, name: string, max: number, required = true): string {
  if (v === undefined || v === null || v === "") {
    if (required) fail(`${name} is required`);
    return "";
  }
  if (typeof v !== "string") fail(`${name} must be text`);
  const t = v.trim();
  if (required && !t) fail(`${name} is required`);
  if (t.length > max) fail(`${name} is too long (max ${max})`);
  return t;
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "creation";
}

function parseSnapshot(raw: string): Snapshot {
  try {
    const s = JSON.parse(raw);
    return { artifacts: Array.isArray(s?.artifacts) ? s.artifacts : [] };
  } catch {
    return { artifacts: [] };
  }
}

/** Items that need a decision stay `open` at the top of the feed; everything else goes straight to history. */
function addFeed(creationId: number, item: { kind: string; priority?: number; title: string; body?: string; ref_type?: string; ref_id?: number; actor: string; open?: boolean }) {
  db.prepare(`INSERT INTO creation_feed (creation_id, kind, priority, title, body, ref_type, ref_id, actor, resolved_at)
    VALUES (?,?,?,?,?,?,?,?, CASE WHEN ? THEN NULL ELSE datetime('now') END)`)
    .run(creationId, item.kind, item.priority ?? 0, item.title, item.body ?? "", item.ref_type ?? null, item.ref_id ?? null, item.actor, item.open ? 1 : 0);
}

function resolveFeed(creationId: number, refType: string, refId: number) {
  db.prepare(`UPDATE creation_feed SET resolved_at = datetime('now') WHERE creation_id = ? AND ref_type = ? AND ref_id = ? AND resolved_at IS NULL`)
    .run(creationId, refType, refId);
}

// ---------- who may do what ----------
// owner (Owner): everything, and the only one who can change canon or phase.
// collaborator: read the creation, start sandboxes, edit/propose from their OWN sandboxes, comment.
// viewer: read and comment.

export type Role = "owner" | "collaborator" | "viewer";

export function roleOf(creationId: number, person: string): Role | null {
  const r = db.prepare(`SELECT role FROM creation_members WHERE creation_id = ? AND person = ? AND status = 'active'`).get(creationId, person) as { role: Role } | undefined;
  return r?.role ?? null;
}

function assertMember(creationId: number, actor: string): Role {
  const role = roleOf(creationId, actor);
  if (!role) fail("creation not found"); // same answer as a missing creation: don't reveal what exists
  return role;
}

/** A sandbox is edited only by whoever owns it. The owner may also work system-made sandboxes. */
function assertCanWork(s: SandboxRow, actor: string) {
  if (SYSTEM_ACTORS.has(actor)) return;
  if (isAgentActor(actor)) {
    if (s.owner === actor && s.owner_kind === "agent") return;
    fail("an agent can only change its own sandbox");
  }
  const role = assertMember(s.creation_id, actor);
  if (s.owner === actor) return;
  if (role === "owner" && (s.owner_kind === "agent" || SYSTEM_ACTORS.has(s.owner))) return;
  fail("only the owner of that sandbox can change it");
}

function touch(creationId: number) {
  db.prepare(`UPDATE creations SET updated_at = datetime('now') WHERE id = ?`).run(creationId);
}

/** Validates an artifact coming from a person or an agent. Space artifacts may only point at this app's own /api/ routes. */
export function normalizeArtifact(input: Record<string, unknown>, existingKey?: string): Artifact {
  const title = str(input.title, "title", 200);
  const kind = (input.kind ?? "doc") as ArtifactKind;
  if (!ARTIFACT_KINDS.includes(kind)) fail(`kind must be one of ${ARTIFACT_KINDS.join(", ")}`);
  const key = existingKey ?? (input.key ? str(input.key, "key", 80) : slugify(title));
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(key)) fail("key must be lowercase letters, numbers and dashes");
  const body = input.body === undefined ? "" : str(input.body, "body", MAX_BODY, false);
  let data = input.data === undefined ? null : input.data;
  if (JSON.stringify(data ?? null).length > MAX_DATA) fail("data is too large");
  if (kind === "model") {
    const engine = (data as { engine?: unknown } | null)?.engine;
    if (engine !== "site-pnl") fail("a model needs data.engine (supported: site-pnl)");
    data = { engine, inputs: normalizeInputs((data as { inputs?: unknown }).inputs) };
  }
  if (kind === "map") data = normalizeMap(data);
  if (kind === "plan") data = normalizePlan(data);
  if (kind === "sites") data = normalizeSites(data);
  if (kind === "space") {
    const src = (data as { src?: unknown } | null)?.src;
    if (typeof src !== "string" || !/^\/api\/[A-Za-z0-9/_-]+$/.test(src)) fail("a space needs data.src pointing at an /api/ route of this app");
  }
  return { key, kind, title, body, data };
}

// ---------- creations ----------

function createCreationRaw(meta: { slug: string; title: string; tagline: string; icon: string; phase: PhaseKey }, artifacts: Artifact[], actor: string, note: string): number {
  return db.transaction(() => {
    const info = db.prepare(`INSERT INTO creations (slug, title, tagline, icon, phase, created_by) VALUES (?,?,?,?,?,?)`)
      .run(meta.slug, meta.title, meta.tagline, meta.icon, meta.phase, actor === "system" ? OWNER : actor);
    const id = Number(info.lastInsertRowid);
    const v = db.prepare(`INSERT INTO creation_versions (creation_id, number, snapshot, note, created_by) VALUES (?, 1, ?, ?, ?)`)
      .run(id, JSON.stringify({ artifacts }), note, actor);
    db.prepare(`UPDATE creations SET canon_version_id = ? WHERE id = ?`).run(Number(v.lastInsertRowid), id);
    db.prepare(`INSERT OR IGNORE INTO creation_members (creation_id, person, role) VALUES (?, ?, 'owner')`).run(id, OWNER);
    addFeed(id, { kind: "version", title: "Canon v1 created", body: note, ref_type: "version", ref_id: Number(v.lastInsertRowid), actor });
    return id;
  })();
}

export function createCreation(input: Record<string, unknown>, actor = OWNER): CreationSummary {
  const title = str(input.title, "title", 120);
  const tagline = str(input.tagline, "tagline", 400, false);
  const icon = str(input.icon, "icon", 8, false) || "✨";
  let slug = slugify(title);
  if (RESERVED_SLUGS.has(slug)) slug = `${slug}-creation`;
  let n = 2;
  const base = slug;
  while (db.prepare(`SELECT 1 FROM creations WHERE slug = ?`).get(slug)) slug = `${base}-${n++}`;
  const vision: Artifact = { key: "vision", kind: "doc", title: "Vision: Real and Ideal", body: "## The Real\n\n## The Ideal\n\n## Success looks like\n", data: null };
  const id = createCreationRaw({ slug, title, tagline, icon, phase: "vision" }, [vision], actor, "Created");
  return getCreationSummary(id)!;
}

const SUMMARY_SQL = `
SELECT c.id, c.slug, c.title, c.tagline, c.icon, c.phase, c.updated_at, v.number AS canon_version, v.snapshot,
  (SELECT COUNT(*) FROM creation_sandboxes s WHERE s.creation_id = c.id AND s.status = 'active') AS sandbox_count,
  (SELECT COUNT(*) FROM creation_promotions p WHERE p.creation_id = c.id AND p.status = 'pending') AS pending_promotions
FROM creations c JOIN creation_versions v ON v.id = c.canon_version_id
WHERE c.status = 'active'`;

type SummaryRaw = Omit<CreationSummary, "artifact_count"> & { snapshot: string };
const toSummary = ({ snapshot, ...r }: SummaryRaw): CreationSummary => ({ ...r, artifact_count: parseSnapshot(snapshot).artifacts.length });

export function listCreations(actor = OWNER): CreationSummary[] {
  const rows = (db.prepare(`${SUMMARY_SQL} AND EXISTS (SELECT 1 FROM creation_members m WHERE m.creation_id = c.id AND m.person = ? AND m.status = 'active') ORDER BY c.updated_at DESC, c.id`).all(actor)) as SummaryRaw[];
  // The pilot always leads.
  return rows.map(toSummary).sort((a, b) => Number(b.slug === "creation-system") - Number(a.slug === "creation-system"));
}

function getCreationSummary(id: number): CreationSummary | undefined {
  const r = db.prepare(`${SUMMARY_SQL} AND c.id = ?`).get(id) as SummaryRaw | undefined;
  return r && toSummary(r);
}

function creationIdBySlug(slug: string): number {
  const r = db.prepare(`SELECT id FROM creations WHERE slug = ? AND status = 'active'`).get(slug) as { id: number } | undefined;
  if (!r) fail("creation not found");
  return r.id;
}

export function setPhase(slug: string, phase: unknown, actor = OWNER): CreationSummary {
  if (!PHASES.some((p) => p.key === phase)) fail("unknown phase");
  const id = creationIdBySlug(slug);
  if (assertMember(id, actor) !== "owner") fail("only the owner can change the phase");
  db.prepare(`UPDATE creations SET phase = ?, updated_at = datetime('now') WHERE id = ?`).run(phase, id);
  const label = PHASES.find((p) => p.key === phase)!.label;
  addFeed(id, { kind: "phase", title: `Phase moved to ${label}`, actor });
  return getCreationSummary(id)!;
}

function versionRow(id: number): (VersionRow & { snapshot: string; creation_id: number }) | undefined {
  return db.prepare(`SELECT id, creation_id, number, note, created_by, created_at, snapshot FROM creation_versions WHERE id = ?`).get(id) as never;
}

const plainVersion = (v: VersionRow): VersionRow => ({ id: v.id, number: v.number, note: v.note, created_by: v.created_by, created_at: v.created_at });

function canonOf(creationId: number) {
  const c = db.prepare(`SELECT canon_version_id FROM creations WHERE id = ?`).get(creationId) as { canon_version_id: number };
  const v = versionRow(c.canon_version_id)!;
  return { version: v, artifacts: parseSnapshot(v.snapshot).artifacts };
}

export function getVersion(id: number, actor = OWNER): { version: VersionRow; artifacts: Artifact[] } {
  const v = versionRow(id);
  if (!v) fail("version not found");
  assertMember(v.creation_id, actor);
  return { version: plainVersion(v), artifacts: parseSnapshot(v.snapshot).artifacts };
}

// ---------- sandboxes ----------

const SANDBOX_SQL = `SELECT s.*, v.number AS base_version FROM creation_sandboxes s JOIN creation_versions v ON v.id = s.base_version_id`;

function sandboxArtifacts(sandboxId: number): Artifact[] {
  const rows = db.prepare(`SELECT key, kind, title, body, data FROM creation_artifacts WHERE sandbox_id = ? AND status = 'active' ORDER BY sort_order, id`)
    .all(sandboxId) as { key: string; kind: ArtifactKind; title: string; body: string; data: string | null }[];
  return rows.map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
}

function writeSandboxArtifacts(sandboxId: number, artifacts: Artifact[], actor: string) {
  // Replace the sandbox's working set: rows not in the new list are archived (not deleted).
  const keep = new Set(artifacts.map((a) => a.key));
  const existing = db.prepare(`SELECT key FROM creation_artifacts WHERE sandbox_id = ?`).all(sandboxId) as { key: string }[];
  for (const { key } of existing) {
    if (!keep.has(key)) db.prepare(`UPDATE creation_artifacts SET status='archived', updated_by=?, updated_at=datetime('now') WHERE sandbox_id=? AND key=?`).run(actor, sandboxId, key);
  }
  const up = db.prepare(`INSERT INTO creation_artifacts (sandbox_id, key, kind, title, body, data, sort_order, status, updated_by)
    VALUES (?,?,?,?,?,?,?, 'active', ?)
    ON CONFLICT(sandbox_id, key) DO UPDATE SET kind=excluded.kind, title=excluded.title, body=excluded.body, data=excluded.data,
      sort_order=excluded.sort_order, status='active', updated_by=excluded.updated_by, updated_at=datetime('now')`);
  artifacts.forEach((a, i) => up.run(sandboxId, a.key, a.kind, a.title, a.body, a.data == null ? null : JSON.stringify(a.data), i, actor));
}

export function createSandbox(slug: string, input: Record<string, unknown>, actor = OWNER, ownerKind: "person" | "agent" = "person"): SandboxRow {
  const creationId = creationIdBySlug(slug);
  if (isAgentActor(actor)) {
    if (ownerKind !== "agent") fail("agent sandboxes must be agent-owned");
  } else if (!SYSTEM_ACTORS.has(actor)) {
    const role = assertMember(creationId, actor);
    if (role === "viewer") fail("viewers can't start sandboxes");
  }
  const title = str(input.title, "title", 120, false) || `${actor === OWNER ? ownerName() : actor.replace(/^agent:/, "")[0].toUpperCase() + actor.replace(/^agent:/, "").slice(1)}'s sandbox`;
  return db.transaction(() => {
    const canon = canonOf(creationId);
    const info = db.prepare(`INSERT INTO creation_sandboxes (creation_id, base_version_id, owner_kind, owner, title) VALUES (?,?,?,?,?)`)
      .run(creationId, canon.version.id, ownerKind, actor, title);
    const id = Number(info.lastInsertRowid);
    writeSandboxArtifacts(id, canon.artifacts, actor);
    addFeed(creationId, { kind: "sandbox", title: `Sandbox "${title}" started from canon v${canon.version.number}`, ref_type: "sandbox", ref_id: id, actor });
    touch(creationId);
    return getSandboxRow(id)!;
  })();
}

function getSandboxRow(id: number): SandboxRow | undefined {
  return db.prepare(`${SANDBOX_SQL} WHERE s.id = ?`).get(id) as SandboxRow | undefined;
}

function activeSandbox(id: number): SandboxRow {
  const s = getSandboxRow(id);
  if (!s) fail("sandbox not found");
  if (s.status !== "active") fail("that sandbox is archived");
  return s;
}

function sandboxChanges(s: SandboxRow): Change[] {
  const base = parseSnapshot(versionRow(s.base_version_id)!.snapshot).artifacts;
  return diffArtifacts(base, sandboxArtifacts(s.id), canonOf(s.creation_id).artifacts);
}

export function getSandbox(id: number, actor = OWNER): SandboxDetail {
  const s = getSandboxRow(id);
  if (!s) fail("sandbox not found");
  if (!SYSTEM_ACTORS.has(actor) && !roleOf(s.creation_id, actor)) fail("sandbox not found");
  const c = db.prepare(`SELECT id, slug, title, canon_version_id FROM creations WHERE id = ?`).get(s.creation_id) as { id: number; slug: string; title: string; canon_version_id: number };
  return {
    sandbox: { ...s, stale: c.canon_version_id !== s.base_version_id },
    creation: { id: c.id, slug: c.slug, title: c.title },
    artifacts: sandboxArtifacts(id),
    changes: sandboxChanges(s),
  };
}

/** Create or update one artifact inside a sandbox. Canon is untouched. */
export function saveArtifact(sandboxId: number, input: Record<string, unknown>, actor = OWNER): Artifact {
  const s = activeSandbox(sandboxId);
  assertCanWork(s, actor);
  if (input.archived === true) {
    const key = str(input.key, "key", 80);
    const r = db.prepare(`UPDATE creation_artifacts SET status='archived', updated_by=?, updated_at=datetime('now') WHERE sandbox_id=? AND key=? AND status='active'`).run(actor, sandboxId, key);
    if (!r.changes) fail("artifact not found");
    db.prepare(`UPDATE creation_sandboxes SET updated_at = datetime('now') WHERE id = ?`).run(sandboxId);
    return { key, kind: "doc", title: "", body: "", data: null };
  }
  const existing = typeof input.key === "string"
    ? (db.prepare(`SELECT key FROM creation_artifacts WHERE sandbox_id = ? AND key = ?`).get(sandboxId, input.key) as { key: string } | undefined)
    : undefined;
  let art = normalizeArtifact(input, existing?.key);
  if (!existing) {
    // New artifact: make the key unique within this sandbox.
    let key = art.key;
    let n = 2;
    while (db.prepare(`SELECT 1 FROM creation_artifacts WHERE sandbox_id = ? AND key = ?`).get(sandboxId, key)) key = `${art.key}-${n++}`;
    art = { ...art, key };
  }
  const order = (db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM creation_artifacts WHERE sandbox_id = ?`).get(sandboxId) as { n: number }).n;
  db.prepare(`INSERT INTO creation_artifacts (sandbox_id, key, kind, title, body, data, sort_order, status, updated_by)
    VALUES (?,?,?,?,?,?,?, 'active', ?)
    ON CONFLICT(sandbox_id, key) DO UPDATE SET kind=excluded.kind, title=excluded.title, body=excluded.body, data=excluded.data,
      status='active', updated_by=excluded.updated_by, updated_at=datetime('now')`)
    .run(sandboxId, art.key, art.kind, art.title, art.body, art.data == null ? null : JSON.stringify(art.data), order, actor);
  db.prepare(`UPDATE creation_sandboxes SET updated_at = datetime('now') WHERE id = ?`).run(s.id);
  touch(s.creation_id);
  return art;
}

export function archiveSandbox(id: number, actor = OWNER): SandboxRow {
  const s = activeSandbox(id);
  assertCanWork(s, actor);
  db.prepare(`UPDATE creation_sandboxes SET status='archived', updated_at=datetime('now') WHERE id = ?`).run(id);
  db.prepare(`UPDATE creation_promotions SET status='superseded' WHERE sandbox_id = ? AND status='pending'`).run(id);
  for (const o of db.prepare(`SELECT id FROM creation_promotions WHERE sandbox_id = ? AND status = 'superseded'`).all(id) as { id: number }[]) resolveFeed(s.creation_id, "promotion", o.id);
  addFeed(s.creation_id, { kind: "sandbox", title: `Sandbox "${s.title}" archived`, actor });
  return getSandboxRow(id)!;
}

/** Pull canon's newer changes into a sandbox, keeping everything the sandbox itself changed. */
export function rebaseSandbox(id: number, actor = OWNER): SandboxDetail {
  const s = activeSandbox(id);
  assertCanWork(s, actor);
  db.transaction(() => {
    const oldBase = parseSnapshot(versionRow(s.base_version_id)!.snapshot).artifacts;
    const canon = canonOf(s.creation_id);
    writeSandboxArtifacts(id, rebaseArtifacts(oldBase, sandboxArtifacts(id), canon.artifacts), actor);
    db.prepare(`UPDATE creation_sandboxes SET base_version_id = ?, updated_at = datetime('now') WHERE id = ?`).run(canon.version.id, id);
  })();
  return getSandbox(id, actor);
}

// ---------- promotions (the only way canon changes) ----------

export function proposePromotion(sandboxId: number, input: Record<string, unknown>, actor = OWNER): PromotionRow {
  const s = activeSandbox(sandboxId);
  assertCanWork(s, actor);
  const changes = sandboxChanges(s);
  if (!changes.length) fail("nothing to propose: this sandbox matches the version it started from");
  const rationale = str(input.rationale, "rationale", 4000, false);
  return db.transaction(() => {
    const old = db.prepare(`SELECT id FROM creation_promotions WHERE sandbox_id = ? AND status = 'pending'`).all(sandboxId) as { id: number }[];
    for (const o of old) {
      db.prepare(`UPDATE creation_promotions SET status='superseded' WHERE id = ?`).run(o.id);
      resolveFeed(s.creation_id, "promotion", o.id);
    }
    const info = db.prepare(`INSERT INTO creation_promotions (creation_id, sandbox_id, base_version_id, changes, rationale, proposed_by) VALUES (?,?,?,?,?,?)`)
      .run(s.creation_id, sandboxId, s.base_version_id, JSON.stringify(changes), rationale, actor);
    const id = Number(info.lastInsertRowid);
    const summary = changes.map((c) => `${c.op} "${c.title}"${c.conflict ? " (conflicts with newer canon)" : ""}`).join(" · ");
    addFeed(s.creation_id, { kind: "promotion", priority: 100, open: true, title: `"${s.title}" proposes ${changes.length} change${changes.length === 1 ? "" : "s"} to canon`, body: rationale || summary, ref_type: "promotion", ref_id: id, actor });
    touch(s.creation_id);
    return getPromotion(id);
  })();
}

const PROMOTION_SQL = `SELECT p.*, s.title AS sandbox_title, bv.number AS base_version, rv.number AS result_version
  FROM creation_promotions p JOIN creation_sandboxes s ON s.id = p.sandbox_id
  JOIN creation_versions bv ON bv.id = p.base_version_id LEFT JOIN creation_versions rv ON rv.id = p.result_version_id`;

type PromotionRaw = Omit<PromotionRow, "changes"> & { changes: string };
const toPromotion = (r: PromotionRaw): PromotionRow => ({ ...r, changes: JSON.parse(r.changes) });

export function getPromotion(id: number, actor = OWNER): PromotionRow {
  const r = db.prepare(`${PROMOTION_SQL} WHERE p.id = ?`).get(id) as PromotionRaw | undefined;
  if (!r) fail("promotion not found");
  if (!SYSTEM_ACTORS.has(actor) && !roleOf(r.creation_id, actor)) fail("promotion not found");
  return toPromotion(r);
}

/**
 * Owner-only. Approving writes a new canon version = current canon + the sandbox's changes.
 * Agents are never given this; collaborators are refused here even if they reach it.
 */
export function decidePromotion(id: number, decision: unknown, actor: string): PromotionRow {
  if (decision !== "approve" && decision !== "decline") fail("decision must be approve or decline");
  const p = getPromotion(id);
  const role = (db.prepare(`SELECT role FROM creation_members WHERE creation_id = ? AND person = ? AND status = 'active'`).get(p.creation_id, actor) as { role: string } | undefined)?.role;
  if (role !== "owner") fail("only the owner can change canon");
  if (p.status !== "pending") fail(`that proposal is already ${p.status}`);
  return db.transaction(() => {
    if (decision === "decline") {
      db.prepare(`UPDATE creation_promotions SET status='declined', decided_by=?, decided_at=datetime('now') WHERE id = ?`).run(actor, id);
      resolveFeed(p.creation_id, "promotion", id);
      addFeed(p.creation_id, { kind: "promotion", title: `Declined: "${p.sandbox_title}" proposal`, actor });
      return getPromotion(id);
    }
    const canon = canonOf(p.creation_id);
    const next = applyChanges(canon.artifacts, p.changes);
    const number = canon.version.number + 1;
    const note = p.rationale || `From sandbox "${p.sandbox_title}"`;
    const v = db.prepare(`INSERT INTO creation_versions (creation_id, number, snapshot, note, promotion_id, created_by) VALUES (?,?,?,?,?,?)`)
      .run(p.creation_id, number, JSON.stringify({ artifacts: next }), note, id, actor);
    const vid = Number(v.lastInsertRowid);
    db.prepare(`UPDATE creations SET canon_version_id = ?, updated_at = datetime('now') WHERE id = ?`).run(vid, p.creation_id);
    db.prepare(`UPDATE creation_promotions SET status='approved', decided_by=?, decided_at=datetime('now'), result_version_id=? WHERE id = ?`).run(actor, vid, id);
    resolveFeed(p.creation_id, "promotion", id);
    addFeed(p.creation_id, { kind: "version", title: `Canon v${number}: ${p.changes.length} change${p.changes.length === 1 ? "" : "s"} from "${p.sandbox_title}"`, body: note, ref_type: "version", ref_id: vid, actor });
    // Keep the promoting sandbox in step with the canon it just produced. One-off starter sandboxes
    // (owned by "system") have done their job, so they're archived instead.
    const s = getSandboxRow(p.sandbox_id);
    if (s?.status === "active" && s.owner === "system") {
      db.prepare(`UPDATE creation_sandboxes SET status='archived', updated_at=datetime('now') WHERE id = ?`).run(s.id);
    } else if (s?.status === "active") {
      const oldBase = parseSnapshot(versionRow(s.base_version_id)!.snapshot).artifacts;
      writeSandboxArtifacts(s.id, rebaseArtifacts(oldBase, sandboxArtifacts(s.id), next), actor);
      db.prepare(`UPDATE creation_sandboxes SET base_version_id = ?, updated_at = datetime('now') WHERE id = ?`).run(vid, s.id);
    }
    return getPromotion(id);
  })();
}

/** One artifact from a sandbox ("s12") or a canon version ("v3"), for read-only renderers like the 3D view. */
export function getArtifactByRef(ref: string, key: string, actor = OWNER): { creationTitle: string; artifact: Artifact } {
  const m = /^([sv])([1-9][0-9]{0,11})$/.exec(ref);
  if (!m) fail("artifact not found");
  const id = Number(m[2]);
  let creationId: number;
  let artifacts: Artifact[];
  if (m[1] === "s") {
    const s = getSandboxRow(id);
    if (!s) fail("artifact not found");
    creationId = s.creation_id;
    artifacts = sandboxArtifacts(id);
  } else {
    const v = versionRow(id);
    if (!v) fail("artifact not found");
    creationId = v.creation_id;
    artifacts = parseSnapshot(v.snapshot).artifacts;
  }
  if (!roleOf(creationId, actor)) fail("artifact not found");
  const artifact = artifacts.find((a) => a.key === key);
  if (!artifact) fail("artifact not found");
  const c = db.prepare(`SELECT title FROM creations WHERE id = ?`).get(creationId) as { title: string };
  return { creationTitle: c.title, artifact };
}

// ---------- the workspace payload ----------

export function getCreation(slug: string, actor = OWNER): CreationDetail {
  const id = creationIdBySlug(slug);
  const role = assertMember(id, actor);
  const canon = canonOf(id);
  const versions = db.prepare(`SELECT id, number, note, created_by, created_at FROM creation_versions WHERE creation_id = ? ORDER BY number DESC`).all(id) as VersionRow[];
  const sandboxes = (db.prepare(`${SANDBOX_SQL} WHERE s.creation_id = ? AND s.status = 'active' ORDER BY s.updated_at DESC`).all(id) as SandboxRow[])
    .map((s) => ({ ...s, change_count: sandboxChanges(s).length, stale: s.base_version_id !== canon.version.id }));
  const promotions = (db.prepare(`${PROMOTION_SQL} WHERE p.creation_id = ? ORDER BY (p.status = 'pending') DESC, p.id DESC LIMIT 50`).all(id) as PromotionRaw[]).map(toPromotion);
  const feed = db.prepare(`SELECT id, kind, priority, title, body, ref_type, ref_id, actor, resolved_at, created_at FROM creation_feed
    WHERE creation_id = ? ORDER BY (resolved_at IS NULL) DESC, CASE WHEN resolved_at IS NULL THEN priority ELSE 0 END DESC, id DESC LIMIT 100`).all(id) as FeedItem[];
  const members = db.prepare(`SELECT person, role FROM creation_members WHERE creation_id = ? AND status = 'active' ORDER BY role = 'owner' DESC, person`).all(id) as { person: string; role: string }[];
  return { role, viewer: actor, creation: getCreationSummary(id)!, canon: { version: plainVersion(canon.version), artifacts: canon.artifacts }, versions, sandboxes, promotions, feed, members };
}

// ---------- comments ----------

/** Any member can comment. Comments stay at the top of the feed until someone marks them done. */
export function addComment(slug: string, input: Record<string, unknown>, actor = OWNER): FeedItem {
  const id = creationIdBySlug(slug);
  if (!isAgentActor(actor)) assertMember(id, actor);
  const body = str(input.body, "comment", 4000);
  const about = input.artifact === undefined ? "" : str(input.artifact, "artifact", 200, false);
  const info = db.prepare(`INSERT INTO creation_feed (creation_id, kind, priority, title, body, actor) VALUES (?, 'comment', 50, ?, ?, ?)`)
    .run(id, about ? `Comment on "${about}"` : "Comment", body, actor);
  touch(id);
  return db.prepare(`SELECT id, kind, priority, title, body, ref_type, ref_id, actor, resolved_at, created_at FROM creation_feed WHERE id = ?`).get(Number(info.lastInsertRowid)) as FeedItem;
}

/** The owner, or whoever wrote it, can mark a comment done (it moves to history). */
export function resolveComment(feedId: number, actor = OWNER): void {
  const f = db.prepare(`SELECT creation_id, kind, actor FROM creation_feed WHERE id = ?`).get(feedId) as { creation_id: number; kind: string; actor: string } | undefined;
  if (!f || f.kind !== "comment") fail("comment not found");
  const role = assertMember(f.creation_id, actor);
  if (role !== "owner" && f.actor !== actor) fail("only the owner or the comment's author can mark it done");
  db.prepare(`UPDATE creation_feed SET resolved_at = datetime('now') WHERE id = ? AND resolved_at IS NULL`).run(feedId);
}
