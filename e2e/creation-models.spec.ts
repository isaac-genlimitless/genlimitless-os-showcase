// Pure logic for The Creation's site-economics model and structure map. No server, no database.
import { test, expect } from "@playwright/test";
import { compute, DEFAULTS, normalizeInputs } from "../src/lib/creations/models/site-pnl";
import { CREATION_SYSTEM_MAP, normalizeMap } from "../src/lib/creations/models/structure-map";

test("site model: totals add up and net = revenue − cost", () => {
  const r = compute(DEFAULTS);
  const rev = r.revenue.reduce((s, l) => s + l.amount, 0);
  const cost = r.costs.reduce((s, l) => s + l.amount, 0);
  expect(r.totalRevenue).toBeCloseTo(rev);
  expect(r.totalCost).toBeCloseTo(cost);
  expect(r.net).toBeCloseTo(rev - cost);
  expect(r.facilitators).toBe(Math.ceil(DEFAULTS.microschool_students / DEFAULTS.students_per_facilitator));
});

test("site model: hand-checked lease case", () => {
  const r = compute({
    ...DEFAULTS, space_mode: 0, microschool_students: 24, tuition_month: 500, school_months: 10, platform_students: 0,
    students_per_facilitator: 12, facilitator_salary: 40000, director_salary: 0, benefits_pct: 0, ai_site_month: 0, ai_student_month: 0,
    building_sqft: 10000, lease_sqft_year: 10, opex_sqft_year: 2, tenant_sqft: 1000, tenant_rent_sqft_year: 20, tenant_occupancy_pct: 100,
    adult_seats: 0, land_lots: 0, solar_kw: 0,
  });
  // in: 24*500*10 = 120,000 tuition + 20,000 tenants; out: 2*40,000 people + 100,000 lease + 20,000 opex
  expect(r.totalRevenue).toBe(140000);
  expect(r.totalCost).toBe(200000);
  expect(r.net).toBe(-60000);
  expect(r.spaceCost).toBe(120000);
  expect(r.spaceCoveredPct).toBeCloseTo(20000 / 120000);
  // each extra 12 students adds 60,000 tuition and 40,000 cost: break-even at 60 students (5 facilitators)
  expect(r.breakEvenStudents).toBe(60);
});

test("site model: owning adds a mortgage and a payback period; inputs are clamped", () => {
  const owned = compute({ ...DEFAULTS, space_mode: 1, purchase_price: 1_000_000, down_pct: 20, interest_pct: 0, loan_years: 20 });
  expect(owned.costs.find((l) => l.key === "mortgage")?.amount).toBeCloseTo(800_000 / 20);
  expect(owned.cashInvested).toBe(200_000);
  const x = normalizeInputs({ microschool_students: -5, benefits_pct: 999, bogus: 1, space_mode: 0.7 });
  expect(x.microschool_students).toBe(0);
  expect(x.benefits_pct).toBe(60);
  expect(x.space_mode).toBe(1);
  expect("bogus" in x).toBe(false);
});

test("structure map: the pilot map is valid, and bad maps are refused", () => {
  expect(normalizeMap(CREATION_SYSTEM_MAP).edges.length).toBe(CREATION_SYSTEM_MAP.edges.length);
  expect(() => normalizeMap({ columns: [] })).toThrow(/1–12 columns/);
  expect(() => normalizeMap({ columns: [{ title: "A", nodes: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }] })).toThrow(/used twice/);
  expect(() => normalizeMap({ columns: [{ title: "A", nodes: [{ id: "a", label: "A" }] }], edges: [{ from: "a", to: "zz" }] })).toThrow(/doesn't exist/);
});
