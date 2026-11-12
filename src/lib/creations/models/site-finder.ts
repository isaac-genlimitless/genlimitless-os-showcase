// Site finder: candidate areas/parcels scored 0–10 on weighted criteria. Unknown scores stay null and are
// excluded (the ranking shows how much of the weight is actually known). Pure; no I/O.

export interface Criterion { key: string; label: string; weight: number } // weight 0–5
export interface Candidate {
  id: string;
  name: string;
  kind: "area" | "parcel" | "building";
  notes: string;
  sources: string[];
  scores: Record<string, number | null>; // 0–10, null = unknown
}
export interface SiteFinder { criteria: Criterion[]; candidates: Candidate[] }

const ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
const txt = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function normalizeSites(raw: unknown): SiteFinder {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (!Array.isArray(src.criteria) || !src.criteria.length || src.criteria.length > 20) throw new Error("the site finder needs 1–20 criteria");
  const keys = new Set<string>();
  const criteria: Criterion[] = src.criteria.map((c: unknown) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const key = txt(o.key, 40);
    if (!ID.test(key) || keys.has(key)) throw new Error(`criterion key "${key}" must be unique lowercase letters, numbers and dashes`);
    keys.add(key);
    const label = txt(o.label, 100);
    if (!label) throw new Error(`criterion "${key}" needs a label`);
    const w = Number(o.weight);
    return { key, label, weight: Number.isFinite(w) ? Math.min(5, Math.max(0, Math.round(w))) : 3 };
  });
  if (!Array.isArray(src.candidates) || src.candidates.length > 200) throw new Error("candidates must be a list (max 200)");
  const ids = new Set<string>();
  const candidates: Candidate[] = src.candidates.map((c: unknown) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const id = txt(o.id, 60);
    if (!ID.test(id) || ids.has(id)) throw new Error(`candidate id "${id}" must be unique lowercase letters, numbers and dashes`);
    ids.add(id);
    const name = txt(o.name, 120);
    if (!name) throw new Error(`candidate "${id}" needs a name`);
    const kind = (["area", "parcel", "building"] as const).find((k) => k === o.kind) ?? "area";
    const sources = (Array.isArray(o.sources) ? o.sources : []).map((s) => txt(s, 300)).filter((s) => /^https?:\/\//.test(s)).slice(0, 20);
    const rawScores = o.scores && typeof o.scores === "object" ? (o.scores as Record<string, unknown>) : {};
    const scores: Record<string, number | null> = {};
    for (const k of keys) {
      const v = rawScores[k];
      const n = v === null || v === undefined || v === "" ? null : Number(v);
      scores[k] = n === null || !Number.isFinite(n) ? null : Math.min(10, Math.max(0, n));
    }
    return { id, name, kind, notes: txt(o.notes, 2000), sources, scores };
  });
  return { criteria, candidates };
}

export interface Ranked { candidate: Candidate; score: number | null; known: number } // score 0–10; known = share of weight scored

export function rankSites(f: SiteFinder): Ranked[] {
  const totalW = f.criteria.reduce((s, c) => s + c.weight, 0);
  return f.candidates
    .map((candidate) => {
      let w = 0;
      let sum = 0;
      for (const c of f.criteria) {
        const v = candidate.scores[c.key];
        if (v === null || v === undefined || c.weight === 0) continue;
        w += c.weight;
        sum += v * c.weight;
      }
      return { candidate, score: w ? sum / w : null, known: totalW ? w / totalW : 0 };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

// ---------- the pilot's first-pass candidates (areas, not parcels: no listings have been checked yet) ----------

export const PILOT_SITES: SiteFinder = {
  criteria: [
    { key: "demand", label: "Family demand nearby", weight: 5 },
    { key: "growth", label: "Population growth", weight: 4 },
    { key: "cost", label: "Land & building cost (10 = cheapest)", weight: 5 },
    { key: "acreage", label: "Room to grow (acreage)", weight: 4 },
    { key: "commute", label: "Commute to regional jobs", weight: 3 },
    { key: "zoning", label: "Zoning for school + tenants + evening use", weight: 3 },
  ],
  candidates: [
    { id: "site-a", name: "Sample Area A (suburban)", kind: "area", notes: "Example data for the showcase.", sources: [],
      scores: { demand: 8, growth: 9, cost: 5, acreage: 5, commute: 7, zoning: null } },
    { id: "site-b", name: "Sample Area B (small town)", kind: "area", notes: "Example data for the showcase.", sources: [],
      scores: { demand: 6, growth: 6, cost: 8, acreage: 7, commute: 5, zoning: null } },
    { id: "site-c", name: "Sample Area C (rural)", kind: "area", notes: "Example data for the showcase.", sources: [],
      scores: { demand: 4, growth: 5, cost: 10, acreage: 10, commute: 3, zoning: null } },
  ],
};
