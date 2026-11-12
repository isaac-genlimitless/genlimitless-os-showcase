// Starting canon for the creations that exist on day one. Content was distilled (read-only) from
// Owner's research pages; nothing here is ever written back anywhere outside this app.
import type { Artifact, PhaseKey } from "./types";
import { DEFAULTS } from "./models/site-pnl";
import { CREATION_SYSTEM_MAP } from "./models/structure-map";
import { CREATION_CENTER_PLAN } from "./models/site-plan";
import { PILOT_SITES } from "./models/site-finder";

export interface SeedCreation {
  slug: string;
  title: string;
  tagline: string;
  icon: string;
  phase: PhaseKey;
  artifacts: Artifact[];
}

const doc = (key: string, title: string, body: string): Artifact => ({ key, kind: "doc", title, body: body.trim() + "\n", data: null });

const VISION = `
**Sample Creation** is example content for the showcase. In the real system a creation holds research docs,
live models, maps and plans that agents propose changes to and the owner approves.
`;

export const SEED_CREATIONS: SeedCreation[] = [
  {
    slug: "sample-creation",
    title: "Sample Creation",
    tagline: "Example creation with a doc, a live model, a structure map and a site finder.",
    icon: "🌱",
    phase: "teardown",
    artifacts: [doc("vision", "Vision", VISION)],
  },
];

/** Starter material added after a creation exists. Each is queued ONCE as a pending proposal (never written to canon directly). */
export interface SeedProposal {
  name: string;
  slug: string;
  sandboxTitle: string;
  rationale: string;
  artifacts: Artifact[];
}

export const SEED_PROPOSALS: SeedProposal[] = [
  {
    name: "sample-creation/stage-2-model-and-map",
    slug: "sample-creation",
    sandboxTitle: "Starter: site economics + structure map",
    rationale:
      "Adds a live per-site economic model (does one site pay for itself, building included?) and a structure map of how families, the site, AI staff and the money fit together. Every number is a placeholder assumption to stress-test.",
    artifacts: [
      {
        key: "site-economics", kind: "model", title: "Site economics: does one site pay for itself?",
        body: "One Creation Center for one year. Change any input to see what it takes for the building to pay for itself. **All defaults are placeholder assumptions**; the ones from research are marked.",
        data: { engine: "site-pnl", inputs: DEFAULTS },
      },
      {
        key: "structure-map", kind: "map", title: "Structure map",
        body: "How the parts connect: families move along the continuum, the site hosts them, AI staff run the operation, and the Starlink engines turn the building into an asset.",
        data: CREATION_SYSTEM_MAP,
      },
    ],
  },
  {
    name: "sample-creation/stage-3-location-lab",
    slug: "sample-creation",
    sandboxTitle: "Starter: Location Lab",
    rationale:
      "Adds the Location Lab: a site finder (first-pass scores for three sample areas from public research; no parcels checked yet) and a Creation Center site prototype with a 2D plan, a 3D view, and a 24×7 utilization clock showing the building working day and night.",
    artifacts: [
      {
        key: "site-finder", kind: "sites", title: "Location Lab: site finder",
        body: "Candidate areas scored 0–10 on what makes a site work. Change the weights to see the ranking move. **Scores are first-pass judgments from public research, not measurements**; blank = unknown (zoning hasn't been checked anywhere yet).",
        data: PILOT_SITES,
      },
      {
        key: "site-plan", kind: "plan", title: "Location Lab: Creation Center prototype",
        body: "One site on 5 acres: learning studios that become the adult studio at night, a family-services wing, a gathering hall, and farm and play space. The clock shows who uses which space when. The goal is a building that works day *and* night.",
        data: CREATION_CENTER_PLAN,
      },
    ],
  },
];
