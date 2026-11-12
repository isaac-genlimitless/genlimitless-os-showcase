// Site plan for one Creation Center: zones (rooms/areas), who uses each one when, a simple layout
// (shared by the 2D plan and the 3D view), and the 24×7 utilization clock. Pure; no I/O.

export const USES = ["learning", "services", "shared", "outdoor", "parking"] as const;
export type Use = (typeof USES)[number];
export const USE_LABEL: Record<Use, string> = {
  learning: "Learning studios",
  services: "Family-services tenants",
  shared: "Shared / community",
  outdoor: "Outdoor / farm",
  parking: "Parking",
};
// Fixed categorical order (validated reference palette slots 1–4) + neutral gray for parking.
export const USE_COLOR: Record<Use, string> = {
  learning: "#2a78d6",
  services: "#eb6834",
  shared: "#1baf7a",
  outdoor: "#eda100",
  parking: "#8a8984",
};

export interface Slot { who: string; days: number[]; start: number; end: number } // days 0=Sun..6=Sat; hours 0–24
export interface Zone { id: string; label: string; use: Use; sqft: number; schedule: Slot[] }
export interface SitePlan { lot_acres: number; building_depth_ft: number; zones: Zone[] }

const ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
const SQFT_PER_ACRE = 43560;
const txt = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function normalizePlan(raw: unknown): SitePlan {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const lot = Number(src.lot_acres);
  if (!Number.isFinite(lot) || lot <= 0 || lot > 2000) throw new Error("lot_acres must be between 0 and 2000");
  const depth = src.building_depth_ft === undefined ? 80 : Number(src.building_depth_ft);
  if (!Number.isFinite(depth) || depth < 20 || depth > 400) throw new Error("building_depth_ft must be 20–400");
  if (!Array.isArray(src.zones) || src.zones.length === 0 || src.zones.length > 60) throw new Error("a plan needs 1–60 zones");
  const ids = new Set<string>();
  const zones: Zone[] = src.zones.map((z: unknown) => {
    const o = (z ?? {}) as Record<string, unknown>;
    const id = txt(o.id, 60);
    if (!ID.test(id)) throw new Error(`zone id "${id}" must be lowercase letters, numbers and dashes`);
    if (ids.has(id)) throw new Error(`zone id "${id}" is used twice`);
    ids.add(id);
    const label = txt(o.label, 80);
    if (!label) throw new Error(`zone "${id}" needs a label`);
    const use = o.use as Use;
    if (!USES.includes(use)) throw new Error(`zone "${id}" use must be one of ${USES.join(", ")}`);
    const sqft = Number(o.sqft);
    if (!Number.isFinite(sqft) || sqft <= 0 || sqft > 5_000_000) throw new Error(`zone "${id}" needs a positive sqft`);
    const schedRaw = Array.isArray(o.schedule) ? o.schedule : [];
    if (schedRaw.length > 40) throw new Error(`zone "${id}" has too many schedule slots`);
    const schedule: Slot[] = schedRaw.map((s: unknown) => {
      const x = (s ?? {}) as Record<string, unknown>;
      const who = txt(x.who, 60) || "use";
      const days = Array.isArray(x.days) ? [...new Set(x.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
      const start = Number(x.start);
      const end = Number(x.end);
      if (!days.length) throw new Error(`zone "${id}" slot "${who}" needs days (0=Sun … 6=Sat)`);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 24 || end <= start) throw new Error(`zone "${id}" slot "${who}" needs 0 ≤ start < end ≤ 24`);
      return { who, days, start, end };
    });
    return { id, label, use, sqft, schedule };
  });
  return { lot_acres: lot, building_depth_ft: depth, zones };
}

export const indoor = (z: Zone) => z.use !== "outdoor" && z.use !== "parking";

// ---------- layout (feet). x = left→right, y = back→front ----------
export interface Rect { id: string; label: string; use: Use; x: number; y: number; w: number; d: number; indoor: boolean }
export interface Layout { lot: { w: number; d: number }; building: { x: number; y: number; w: number; d: number }; rects: Rect[]; fits: boolean }

/** Building zones in one strip (fixed depth) at the back of the lot; outdoor + parking as blocks in front. */
export function layoutPlan(plan: SitePlan): Layout {
  const lotArea = plan.lot_acres * SQFT_PER_ACRE;
  const lotW = Math.sqrt(lotArea * 1.6);
  const lotD = lotArea / lotW;
  const margin = Math.min(40, lotW * 0.05);
  const depth = plan.building_depth_ft;
  const rects: Rect[] = [];
  let x = margin;
  for (const z of plan.zones.filter(indoor)) {
    const w = z.sqft / depth;
    rects.push({ id: z.id, label: z.label, use: z.use, x, y: margin, w, d: depth, indoor: true });
    x += w;
  }
  const building = { x: margin, y: margin, w: x - margin, d: depth };
  // Outside: one row in front of the building; each block uses the full front depth (width = sqft / depth).
  const gap = 20;
  const frontY = margin + depth + 30;
  const frontD = Math.max(1, lotD - margin - frontY);
  let ox = margin;
  for (const z of plan.zones.filter((z) => !indoor(z))) {
    const w = z.sqft / frontD;
    rects.push({ id: z.id, label: z.label, use: z.use, x: ox, y: frontY, w, d: frontD, indoor: false });
    ox += w + gap;
  }
  const fits = rects.every((r) => r.x + r.w <= lotW + 0.5 && r.y + r.d <= lotD + 0.5);
  return { lot: { w: lotW, d: lotD }, building, rects, fits };
}

// ---------- utilization ----------
export interface Utilization {
  grid: number[][]; // [day][hour] = share of indoor sqft in use (0–1)
  weekly: number; // share of indoor sqft-hours used across the whole week (0–1)
  schoolHoursOnly: number; // what the same building would be at if only the weekday 8–15 school slots ran
  byWho: { who: string; sqftHours: number }[];
  indoorSqft: number;
  outdoorSqft: number;
  coverage: number; // building footprint / lot area
}

export function utilization(plan: SitePlan): Utilization {
  const zones = plan.zones.filter(indoor);
  const indoorSqft = zones.reduce((s, z) => s + z.sqft, 0);
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  const byWho = new Map<string, number>();
  let schoolUsed = 0;
  for (const z of zones) {
    // Share of each hour this zone is in use. Overlapping slots don't double-count: the hour is covered
    // by the union of the slots (approximated per hour by the largest covered fraction).
    const used = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    for (const s of z.schedule) {
      for (const d of s.days) {
        for (let h = Math.floor(s.start); h < Math.ceil(s.end); h++) {
          const frac = Math.min(h + 1, s.end) - Math.max(h, s.start);
          if (frac <= 0) continue;
          used[d][h] = Math.max(used[d][h], frac);
          byWho.set(s.who, (byWho.get(s.who) ?? 0) + z.sqft * frac);
        }
      }
    }
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) grid[d][h] += (z.sqft * used[d][h]) / Math.max(indoorSqft, 1);
    for (let d = 1; d <= 5; d++) for (let h = 8; h < 15; h++) schoolUsed += z.sqft * used[d][h];
  }
  const total = indoorSqft * 24 * 7;
  const usedTotal = grid.flat().reduce((s, v) => s + v, 0) * indoorSqft;
  return {
    grid: grid.map((row) => row.map((v) => Math.min(1, v))),
    weekly: total ? usedTotal / total : 0,
    schoolHoursOnly: total ? schoolUsed / total : 0,
    byWho: [...byWho.entries()].map(([who, sqftHours]) => ({ who, sqftHours })).sort((a, b) => b.sqftHours - a.sqftHours),
    indoorSqft,
    outdoorSqft: plan.zones.filter((z) => z.use === "outdoor").reduce((s, z) => s + z.sqft, 0),
    coverage: indoorSqft / (plan.lot_acres * SQFT_PER_ACRE),
  };
}

// ---------- the pilot's starting prototype ----------
const WK = [1, 2, 3, 4, 5];
export const CREATION_CENTER_PLAN: SitePlan = {
  lot_acres: 5,
  building_depth_ft: 80,
  zones: [
    { id: "studios", label: "Learning studios (6)", use: "learning", sqft: 4800, schedule: [
      { who: "Micro school", days: [1, 4], start: 8, end: 15 },
      { who: "Co-op classes", days: [2, 3], start: 9, end: 14 },
      { who: "Adults by night", days: WK, start: 18, end: 21 },
      { who: "Adults by night", days: [6], start: 9, end: 15 },
    ] },
    { id: "maker", label: "Maker space / commons", use: "learning", sqft: 2000, schedule: [
      { who: "Micro school", days: [1, 4], start: 8, end: 15 },
      { who: "Co-op classes", days: [2, 3], start: 9, end: 14 },
      { who: "Student ventures", days: WK, start: 15, end: 18 },
      { who: "Adults by night", days: [2, 4], start: 18, end: 21 },
    ] },
    { id: "services", label: "Family-services wing", use: "services", sqft: 4000, schedule: [
      { who: "Tenants", days: WK, start: 8, end: 18 },
      { who: "Tenants", days: [6], start: 9, end: 13 },
    ] },
    { id: "hall", label: "Gathering hall", use: "shared", sqft: 2000, schedule: [
      { who: "Micro school", days: [1, 4], start: 8, end: 9 },
      { who: "Gatherings", days: [4], start: 19, end: 21 },
      { who: "Community events", days: [6], start: 10, end: 14 },
    ] },
    { id: "office", label: "Staff office", use: "shared", sqft: 600, schedule: [{ who: "Staff", days: WK, start: 7, end: 18 }] },
    { id: "farm", label: "Farm & garden", use: "outdoor", sqft: 40000, schedule: [
      { who: "Micro school", days: [1, 4], start: 10, end: 12 },
      { who: "Farm market", days: [6], start: 8, end: 12 },
    ] },
    { id: "play", label: "Play & sports field", use: "outdoor", sqft: 30000, schedule: [{ who: "Micro school", days: [1, 4], start: 12, end: 13 }] },
    { id: "parking", label: "Parking (60 spaces)", use: "parking", sqft: 21000, schedule: [] },
  ],
};
