// Pure logic for The Creation's Location Lab: site plan layout + utilization, site finder ranking, 3D page safety.
import { test, expect } from "@playwright/test";
import { CREATION_CENTER_PLAN, layoutPlan, normalizePlan, utilization } from "../src/lib/creations/models/site-plan";
import { normalizeSites, PILOT_SITES, rankSites } from "../src/lib/creations/models/site-finder";
import { buildSite3dHtml } from "../src/lib/creations/site3d-html";

test("utilization: hand-checked numbers", () => {
  const plan = normalizePlan({
    lot_acres: 1,
    zones: [
      { id: "a", label: "A", use: "learning", sqft: 1000, schedule: [{ who: "School", days: [1, 2, 3, 4, 5], start: 8, end: 15 }] },
      { id: "b", label: "B", use: "services", sqft: 1000, schedule: [{ who: "Tenants", days: [1], start: 9, end: 10.5 }, { who: "Tenants", days: [1], start: 10, end: 11 }] },
      { id: "f", label: "Field", use: "outdoor", sqft: 5000, schedule: [] },
    ],
  });
  const u = utilization(plan);
  expect(u.indoorSqft).toBe(2000);
  expect(u.outdoorSqft).toBe(5000);
  // Mon 9–10: A fully + B fully = 100%; Mon 10–11: overlapping B slots count once.
  expect(u.grid[1][9]).toBeCloseTo(1);
  expect(u.grid[1][10]).toBeCloseTo(1);
  expect(u.grid[1][7]).toBe(0);
  // sqft-hours: A 1000*7*5 = 35,000; B 1000*2 = 2,000 → 37,000 of 2000*168 = 336,000
  expect(u.weekly).toBeCloseTo(37000 / 336000);
});

test("pilot plan: valid, fits its lot, and evenings/weekends lift use above school hours alone", () => {
  const plan = normalizePlan(CREATION_CENTER_PLAN);
  const L = layoutPlan(plan);
  expect(L.fits).toBe(true);
  expect(L.rects.filter((r) => r.indoor).reduce((s, r) => s + r.w * r.d, 0)).toBeCloseTo(13400);
  const u = utilization(plan);
  expect(u.weekly).toBeGreaterThan(u.schoolHoursOnly);
  expect(u.byWho.map((w) => w.who)).toContain("Adults by night");
});

test("plan validation refuses bad zones and schedules", () => {
  const zone = { id: "a", label: "A", use: "learning", sqft: 100, schedule: [] as unknown[] };
  expect(() => normalizePlan({ lot_acres: 0, zones: [zone] })).toThrow(/lot_acres/);
  expect(() => normalizePlan({ lot_acres: 1, zones: [{ ...zone, use: "casino" }] })).toThrow(/use must be/);
  expect(() => normalizePlan({ lot_acres: 1, zones: [zone, zone] })).toThrow(/used twice/);
  expect(() => normalizePlan({ lot_acres: 1, zones: [{ ...zone, schedule: [{ who: "x", days: [1], start: 15, end: 8 }] }] })).toThrow(/start < end/);
});

test("site finder: weighted ranking ignores unknowns and reports known weight", () => {
  const f = normalizeSites({
    criteria: [{ key: "a", label: "A", weight: 3 }, { key: "b", label: "B", weight: 1 }],
    candidates: [
      { id: "x", name: "X", scores: { a: 10, b: 0 } },
      { id: "y", name: "Y", scores: { a: null, b: 10 } },
      { id: "z", name: "Z", scores: {} },
    ],
  });
  const r = rankSites(f);
  expect(r.map((x) => x.candidate.id)).toEqual(["y", "x", "z"]);
  expect(r[0].score).toBe(10);
  expect(r[0].known).toBeCloseTo(0.25);
  expect(r[1].score).toBeCloseTo(7.5);
  expect(r[2].score).toBeNull();
  expect(rankSites(normalizeSites(PILOT_SITES))).toHaveLength(5);
  expect(() => normalizeSites({ criteria: [], candidates: [] })).toThrow(/1–20 criteria/);
});

test("3D page: plan text can't break out of the data script", () => {
  const plan = normalizePlan({ lot_acres: 1, zones: [{ id: "a", label: "</script><script>alert(1)</script>", use: "learning", sqft: 500, schedule: [] }] });
  const html = buildSite3dHtml("T <b>", plan);
  expect(html).not.toContain("<script>alert(1)");
  expect(html).toContain("\\u003c/script>");
  expect(html).toContain("T &lt;b&gt;");
  expect(html).toContain('type="importmap"');
});
