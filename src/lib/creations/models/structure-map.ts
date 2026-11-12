// Structure map: columns of parts, plus labeled connections between them. Pure data + validation.

export interface MapNode { id: string; label: string; notes?: string }
export interface MapColumn { title: string; nodes: MapNode[] }
export interface MapEdge { from: string; to: string; label?: string }
export interface StructureMap { columns: MapColumn[]; edges: MapEdge[] }

const ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Throws on a malformed map; returns a cleaned copy (unknown edge endpoints are rejected). */
export function normalizeMap(raw: unknown): StructureMap {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (!Array.isArray(src.columns) || src.columns.length === 0 || src.columns.length > 12) throw new Error("a map needs 1–12 columns");
  const ids = new Set<string>();
  const columns: MapColumn[] = src.columns.map((c: unknown) => {
    const col = (c ?? {}) as Record<string, unknown>;
    const title = text(col.title, 80);
    if (!title) throw new Error("every map column needs a title");
    if (!Array.isArray(col.nodes) || col.nodes.length > 40) throw new Error(`column "${title}" needs 0–40 nodes`);
    const nodes = col.nodes.map((n: unknown) => {
      const node = (n ?? {}) as Record<string, unknown>;
      const id = text(node.id, 60);
      const label = text(node.label, 120);
      if (!ID.test(id)) throw new Error(`map node id "${id}" must be lowercase letters, numbers and dashes`);
      if (!label) throw new Error(`map node "${id}" needs a label`);
      if (ids.has(id)) throw new Error(`map node id "${id}" is used twice`);
      ids.add(id);
      const notes = text(node.notes, 600);
      return notes ? { id, label, notes } : { id, label };
    });
    return { title, nodes };
  });
  const edgesRaw = Array.isArray(src.edges) ? src.edges : [];
  if (edgesRaw.length > 300) throw new Error("too many connections");
  const edges: MapEdge[] = edgesRaw.map((e: unknown) => {
    const edge = (e ?? {}) as Record<string, unknown>;
    const from = text(edge.from, 60);
    const to = text(edge.to, 60);
    if (!ids.has(from) || !ids.has(to)) throw new Error(`connection ${from} → ${to} points at a node that doesn't exist`);
    const label = text(edge.label, 120);
    return label ? { from, to, label } : { from, to };
  });
  return { columns, edges };
}

const n = (id: string, label: string, notes?: string): MapNode => (notes ? { id, label, notes } : { id, label });

export const CREATION_SYSTEM_MAP: StructureMap = {
  columns: [
    {
      title: "Community & funnel",
      nodes: [
        n("gatherings", "Stake / neighborhood gatherings", "Prepare → Gather → Teach → Connect. A liaison hosts and routes families to the right tier."),
        n("free-content", "Free 'creating creators' content", "Curriculum and content as the top of the funnel, not the product (pillar 3)."),
        n("alumni", "Alumni & parents as mentors", "Placed students and parents become mentors, referrers and employers (pillar 5)."),
      ],
    },
    {
      title: "Families (the continuum)",
      nodes: [
        n("tier-homeschool", "Homeschool parent", "Curriculum + AI assistant on the platform."),
        n("tier-coop", "Co-op", "Shared classes in the building; volunteer-led with platform support."),
        n("tier-micro", "Micro school (drop-off)", "Hybrid week: Mon in person, Tue/Wed home, Thu finish. Solves the 'safe place while I work' job."),
        n("tier-campus", "Full campus", "Long-term ceiling."),
        n("adults", "Adults (evenings & weekends)", "AI upskilling and creator programs for parents and the community."),
      ],
    },
    {
      title: "The Creation Center (one site)",
      nodes: [
        n("studios", "Studios / learning rooms"),
        n("facilitators", "Facilitators (TeamTeach)", "About 10 minutes of prep; no subject expert needed in every room."),
        n("director", "Site director"),
        n("services-wing", "Family-services wing", "Pediatrics, dental, therapy, music, martial arts, tutoring. Tenants, not operated by us."),
        n("adult-studio", "Adult studio (same rooms, after hours)"),
        n("outdoor", "Outdoor / farm space", "Barn and farm-school demand in the region."),
        n("roof", "Roof & land"),
      ],
    },
    {
      title: "AI staff",
      nodes: [
        n("cos", "Chief of Staff", "Manages the AI staff; humans approve through one feed."),
        n("ai-sales", "Marketing & sales agents"),
        n("ai-support", "Support agents", "Actually solve problems, not just answer questions."),
        n("ai-fulfill", "Fulfillment / customization agents"),
        n("ai-tutor", "AI tutor + learner model", "One per child; daily-use value (pillar 2)."),
      ],
    },
    {
      title: "Money in",
      nodes: [
        n("rev-platform", "Platform fees", "About $20 per student per month."),
        n("rev-tuition", "Micro-school tuition"),
        n("rev-tenants", "Tenant rent + revenue share", "Starlink engine #2."),
        n("rev-adults", "Adult programs", "Starlink engine #3: the cash-flow bridge."),
        n("rev-land", "Land-value capture", "Starlink engine #1: own the land the school lifts."),
        n("rev-energy", "Energy", "Starlink engine #5."),
        n("rev-ventures", "Student venture share", "Starlink engine #6. Long-dated."),
      ],
    },
  ],
  edges: [
    { from: "gatherings", to: "tier-homeschool", label: "routes families into a tier" },
    { from: "gatherings", to: "tier-coop", label: "routes families into a tier" },
    { from: "gatherings", to: "tier-micro", label: "routes families into a tier" },
    { from: "free-content", to: "gatherings", label: "brings families to gatherings" },
    { from: "alumni", to: "gatherings", label: "refers the next families" },
    { from: "tier-homeschool", to: "rev-platform", label: "pays" },
    { from: "tier-coop", to: "rev-platform", label: "pays" },
    { from: "tier-micro", to: "rev-tuition", label: "pays" },
    { from: "tier-micro", to: "studios", label: "drop-off days" },
    { from: "tier-coop", to: "studios", label: "class days" },
    { from: "adults", to: "adult-studio", label: "evenings" },
    { from: "adult-studio", to: "rev-adults", label: "earns" },
    { from: "services-wing", to: "rev-tenants", label: "earns" },
    { from: "tier-micro", to: "services-wing", label: "member pricing (pillar 4)" },
    { from: "roof", to: "rev-energy", label: "earns" },
    { from: "roof", to: "rev-land", label: "earns" },
    { from: "outdoor", to: "rev-ventures", label: "student-run ventures" },
    { from: "facilitators", to: "studios", label: "run" },
    { from: "director", to: "facilitators", label: "leads" },
    { from: "cos", to: "ai-sales", label: "manages" },
    { from: "cos", to: "ai-support", label: "manages" },
    { from: "cos", to: "ai-fulfill", label: "manages" },
    { from: "ai-sales", to: "gatherings", label: "finds & books" },
    { from: "ai-tutor", to: "tier-homeschool", label: "daily learning" },
    { from: "ai-tutor", to: "facilitators", label: "does the prep" },
    { from: "director", to: "cos", label: "works through" },
  ],
};
