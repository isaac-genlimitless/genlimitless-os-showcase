// Shared types for The Creation (client + server). No imports, so client components can use them.

export const ARTIFACT_KINDS = ["doc", "model", "map", "plan", "sites", "space", "sim", "deck", "research"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

// The 0→1 loop every creation walks. Neutral names on screen; the Creation System pattern each one
// mirrors is kept alongside for the agents' guidance.
export const PHASES = [
  { key: "vision", label: "Vision", pattern: "Premortal vision" },
  { key: "teardown", label: "Tear down", pattern: "Creation" },
  { key: "explore", label: "Explore", pattern: "Fall" },
  { key: "prototype", label: "Prototype", pattern: "Atonement" },
  { key: "stress", label: "Stress test", pattern: "Atonement" },
  { key: "simplify", label: "Simplify", pattern: "New simplicity" },
  { key: "execute", label: "Execute", pattern: "Endure to the end" },
] as const;
export type PhaseKey = (typeof PHASES)[number]["key"];

/** One thing inside a creation: a doc, a model, a 3D space... `key` is stable across versions. */
export interface Artifact {
  key: string;
  kind: ArtifactKind;
  title: string;
  body: string; // markdown (docs, notes); may be empty for data-only artifacts
  data: unknown; // kind-specific structured data (e.g. { src } for a space)
}

export interface Snapshot {
  artifacts: Artifact[];
}

export type ChangeOp = "add" | "change" | "remove";
export interface Change {
  op: ChangeOp;
  key: string;
  title: string;
  before: Artifact | null;
  after: Artifact | null;
  /** Canon changed this artifact after the sandbox was forked; approving overwrites that change. */
  conflict?: boolean;
}

export interface CreationSummary {
  id: number;
  slug: string;
  title: string;
  tagline: string;
  icon: string;
  phase: PhaseKey;
  canon_version: number;
  artifact_count: number;
  sandbox_count: number;
  pending_promotions: number;
  updated_at: string;
}

export interface VersionRow {
  id: number;
  number: number;
  note: string;
  created_by: string;
  created_at: string;
}

export interface SandboxRow {
  id: number;
  creation_id: number;
  base_version_id: number;
  base_version: number;
  owner_kind: "person" | "agent";
  owner: string;
  title: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
  change_count?: number;
  stale?: boolean; // canon has moved on since this sandbox's base
}

export interface PromotionRow {
  id: number;
  creation_id: number;
  sandbox_id: number;
  sandbox_title: string;
  base_version: number;
  changes: Change[];
  rationale: string;
  status: "pending" | "approved" | "declined" | "superseded";
  proposed_by: string;
  decided_by: string | null;
  decided_at: string | null;
  result_version: number | null;
  created_at: string;
}

export interface FeedItem {
  id: number;
  kind: string;
  priority: number; // higher = more important, shown first while unresolved
  title: string;
  body: string;
  ref_type: string | null;
  ref_id: number | null;
  actor: string;
  resolved_at: string | null;
  created_at: string;
}

export interface CreationDetail {
  role: "owner" | "collaborator" | "viewer"; // the viewer's role on this creation
  viewer: string; // who is looking ("owner", "partner", ...)
  creation: CreationSummary;
  canon: { version: VersionRow; artifacts: Artifact[] };
  versions: VersionRow[];
  sandboxes: SandboxRow[];
  promotions: PromotionRow[];
  feed: FeedItem[];
  members: { person: string; role: string }[];
}

export interface SandboxDetail {
  sandbox: SandboxRow;
  creation: { id: number; slug: string; title: string };
  artifacts: Artifact[];
  changes: Change[];
}
