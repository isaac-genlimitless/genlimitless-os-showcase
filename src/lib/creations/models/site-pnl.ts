// Per-site economics for The Creation System: "does one site pay for itself, building included?"
// Pure functions shared by the browser (live what-ifs) and the server (validation). No I/O.
//
// Every default below is a PLACEHOLDER assumption to be stress-tested, not a researched fact.
// The ones that come from Owner's research are marked (src: ...).

export type InputKey =
  | "microschool_students" | "tuition_month" | "school_months"
  | "platform_students" | "platform_month"
  | "students_per_facilitator" | "facilitator_salary" | "director_salary" | "benefits_pct"
  | "ai_site_month" | "ai_student_month"
  | "space_mode" | "building_sqft" | "lease_sqft_year" | "purchase_price" | "down_pct" | "interest_pct" | "loan_years" | "opex_sqft_year"
  | "tenant_sqft" | "tenant_rent_sqft_year" | "tenant_occupancy_pct"
  | "adult_hours_week" | "adult_seats" | "adult_utilization_pct" | "adult_price_seat_hour" | "adult_weeks" | "adult_instructor_hour"
  | "land_lots" | "land_lift_per_lot" | "land_capture_pct" | "land_years"
  | "solar_kw" | "solar_revenue_kw_year";

export interface InputDef {
  key: InputKey;
  label: string;
  unit: "$" | "%" | "#" | "sqft" | "mode";
  min: number;
  max: number;
  step: number;
  default: number;
  note?: string;
}

export interface Section {
  title: string;
  inputs: InputDef[];
}

const i = (key: InputKey, label: string, unit: InputDef["unit"], def: number, min: number, max: number, step: number, note?: string): InputDef =>
  ({ key, label, unit, default: def, min, max, step, note });

export const SECTIONS: Section[] = [
  {
    title: "Families",
    inputs: [
      i("microschool_students", "Micro-school (drop-off) students", "#", 120, 0, 2000, 1),
      i("tuition_month", "Micro-school tuition / student / month", "$", 650, 0, 5000, 10),
      i("school_months", "Months billed per year", "#", 10, 1, 12, 1),
      i("platform_students", "Platform-only students (homeschool & co-op tiers)", "#", 300, 0, 20000, 10),
      i("platform_month", "Platform fee / student / month", "$", 20, 0, 500, 1, "placeholder assumption"),
    ],
  },
  {
    title: "People",
    inputs: [
      i("students_per_facilitator", "Students per facilitator", "#", 12, 1, 60, 1, "TeamTeach: about 10 min of prep, no subject expert needed"),
      i("facilitator_salary", "Facilitator salary / year", "$", 42000, 0, 200000, 1000),
      i("director_salary", "Site director salary / year", "$", 70000, 0, 300000, 1000),
      i("benefits_pct", "Benefits & payroll tax", "%", 20, 0, 60, 1),
      i("ai_site_month", "AI staff / site / month", "$", 100, 0, 10000, 10, "placeholder assumption"),
      i("ai_student_month", "AI tutor / student / month", "$", 4, 0, 200, 1),
    ],
  },
  {
    title: "Building",
    inputs: [
      i("space_mode", "Lease (0) or own (1)", "mode", 1, 0, 1, 1),
      i("building_sqft", "Building size", "sqft", 14000, 1000, 200000, 500),
      i("lease_sqft_year", "Lease rate / sqft / year", "$", 18, 0, 200, 1),
      i("purchase_price", "Purchase / build cost", "$", 2800000, 0, 50000000, 50000),
      i("down_pct", "Down payment", "%", 25, 0, 100, 1),
      i("interest_pct", "Loan interest rate", "%", 7, 0, 20, 0.25),
      i("loan_years", "Loan term (years)", "#", 25, 1, 40, 1),
      i("opex_sqft_year", "Utilities, upkeep, insurance / sqft / year", "$", 6, 0, 50, 0.5),
    ],
  },
  {
    title: "Engine: family-services tenants",
    inputs: [
      i("tenant_sqft", "Leasable tenant space", "sqft", 4000, 0, 100000, 100, "Pediatrics, dental, therapy, music, martial arts and tutoring, with the school as anchor"),
      i("tenant_rent_sqft_year", "Tenant rent / sqft / year", "$", 26, 0, 200, 1),
      i("tenant_occupancy_pct", "Tenant occupancy", "%", 85, 0, 100, 1),
    ],
  },
  {
    title: "Engine: adults by night",
    inputs: [
      i("adult_hours_week", "Evening/weekend hours / week", "#", 12, 0, 80, 1),
      i("adult_seats", "Seats", "#", 30, 0, 500, 1),
      i("adult_utilization_pct", "Seats filled", "%", 50, 0, 100, 1),
      i("adult_price_seat_hour", "Price / seat / hour", "$", 15, 0, 500, 1, "Adults pay 3–5x per hour (AI upskilling)"),
      i("adult_weeks", "Weeks / year", "#", 46, 0, 52, 1),
      i("adult_instructor_hour", "Instructor cost / hour", "$", 55, 0, 500, 5),
    ],
  },
  {
    title: "Engine: land-value capture",
    inputs: [
      i("land_lots", "Lots around the site", "#", 0, 0, 5000, 10, "Set above 0 to test engine #1: own or option land around the school"),
      i("land_lift_per_lot", "Value lift per lot from the school", "$", 30000, 0, 1000000, 1000, "A good school lifts home values 10–20%"),
      i("land_capture_pct", "Share of the lift captured", "%", 50, 0, 100, 1),
      i("land_years", "Years to realize", "#", 10, 1, 40, 1),
    ],
  },
  {
    title: "Engine: energy",
    inputs: [
      i("solar_kw", "Roof solar", "#", 0, 0, 5000, 10, "kW installed (0 = off)"),
      i("solar_revenue_kw_year", "Net revenue / kW / year", "$", 120, 0, 1000, 5),
    ],
  },
];

export const INPUTS: InputDef[] = SECTIONS.flatMap((s) => s.inputs);
export type Inputs = Record<InputKey, number>;
export const DEFAULTS: Inputs = Object.fromEntries(INPUTS.map((d) => [d.key, d.default])) as Inputs;

/** Fills missing keys with defaults and clamps everything into range. Unknown keys are dropped. */
export function normalizeInputs(raw: unknown): Inputs {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULTS };
  for (const d of INPUTS) {
    const v = Number(src[d.key]);
    if (Number.isFinite(v)) out[d.key] = Math.min(d.max, Math.max(d.min, v));
  }
  out.space_mode = out.space_mode >= 0.5 ? 1 : 0;
  return out;
}

export interface Line {
  key: string;
  label: string;
  amount: number; // dollars per year
  starlink?: boolean; // a revenue engine that exists because we own/run the building
}

export interface Result {
  revenue: Line[];
  costs: Line[];
  totalRevenue: number;
  totalCost: number;
  net: number;
  margin: number; // net / revenue
  spaceCost: number; // what the building costs per year (lease, or mortgage + opex)
  starlinkRevenue: number;
  spaceCoveredPct: number; // starlink revenue / space cost
  facilitators: number;
  costPerStudent: number; // total cost / micro-school student / year
  breakEvenStudents: number | null; // micro-school students needed for net >= 0, everything else fixed
  cashInvested: number; // down payment if owned
  paybackYears: number | null; // cash invested / net, if owned and net > 0
}

function mortgagePayment(principal: number, ratePct: number, years: number): number {
  if (principal <= 0) return 0;
  const r = ratePct / 100 / 12;
  const n = years * 12;
  const monthly = r === 0 ? principal / n : (principal * r) / (1 - Math.pow(1 + r, -n));
  return monthly * 12;
}

/** Every revenue and cost line for one set of inputs. The single source of the math. */
function ledger(x: Inputs) {
  const owned = x.space_mode === 1;
  const facilitators = x.microschool_students > 0 ? Math.ceil(x.microschool_students / x.students_per_facilitator) : 0;
  const load = 1 + x.benefits_pct / 100;

  const tuition = x.microschool_students * x.tuition_month * x.school_months;
  const platform = x.platform_students * x.platform_month * 12;
  const tenants = x.tenant_sqft * x.tenant_rent_sqft_year * (x.tenant_occupancy_pct / 100);
  const adultRevenue = x.adult_hours_week * x.adult_weeks * x.adult_seats * (x.adult_utilization_pct / 100) * x.adult_price_seat_hour;
  const land = (x.land_lots * x.land_lift_per_lot * (x.land_capture_pct / 100)) / x.land_years;
  const solar = x.solar_kw * x.solar_revenue_kw_year;

  const revenue: Line[] = [
    { key: "tuition", label: "Micro-school tuition", amount: tuition },
    { key: "platform", label: "Platform fees (homeschool & co-op)", amount: platform },
    { key: "tenants", label: "Family-services tenants", amount: tenants, starlink: true },
    { key: "adults", label: "Adults by night", amount: adultRevenue, starlink: true },
    { key: "land", label: "Land-value capture (per year)", amount: land, starlink: true },
    { key: "solar", label: "Energy", amount: solar, starlink: true },
  ].filter((l) => l.amount > 0);

  const people = (facilitators * x.facilitator_salary + x.director_salary) * load;
  const ai = x.ai_site_month * 12 + (x.microschool_students + x.platform_students) * x.ai_student_month * 12;
  const instructors = x.adult_seats > 0 ? x.adult_hours_week * x.adult_weeks * x.adult_instructor_hour : 0;
  const opex = x.building_sqft * x.opex_sqft_year;
  const loan = owned ? mortgagePayment(x.purchase_price * (1 - x.down_pct / 100), x.interest_pct, x.loan_years) : 0;
  const lease = owned ? 0 : x.building_sqft * x.lease_sqft_year;

  const costs: Line[] = [
    { key: "people", label: `Facilitators (${facilitators}) + director, with benefits`, amount: people },
    { key: "ai", label: "AI staff + AI tutors", amount: ai },
    owned ? { key: "mortgage", label: "Mortgage payments", amount: loan } : { key: "lease", label: "Lease", amount: lease },
    { key: "opex", label: "Utilities, upkeep, insurance", amount: opex },
    { key: "instructors", label: "Adult-program instructors", amount: instructors },
  ].filter((l) => l.amount > 0);

  const totalRevenue = revenue.reduce((s, l) => s + l.amount, 0);
  const totalCost = costs.reduce((s, l) => s + l.amount, 0);
  return { owned, facilitators, revenue, costs, totalRevenue, totalCost, net: totalRevenue - totalCost, spaceCost: (owned ? loan : lease) + opex };
}

export function compute(raw: unknown): Result {
  const x = normalizeInputs(raw);
  const L = ledger(x);
  const starlinkRevenue = L.revenue.filter((l) => l.starlink).reduce((s, l) => s + l.amount, 0);

  // Break-even: smallest micro-school headcount where net >= 0 (facilitators step up every N students).
  let breakEvenStudents: number | null = null;
  for (let n = 0; n <= 2000; n++) {
    if (ledger({ ...x, microschool_students: n }).net >= 0) { breakEvenStudents = n; break; }
  }

  const cashInvested = L.owned ? x.purchase_price * (x.down_pct / 100) : 0;
  return {
    revenue: L.revenue, costs: L.costs, totalRevenue: L.totalRevenue, totalCost: L.totalCost, net: L.net,
    margin: L.totalRevenue > 0 ? L.net / L.totalRevenue : 0,
    spaceCost: L.spaceCost, starlinkRevenue,
    spaceCoveredPct: L.spaceCost > 0 ? starlinkRevenue / L.spaceCost : 0,
    facilitators: L.facilitators,
    costPerStudent: x.microschool_students > 0 ? L.totalCost / x.microschool_students : 0,
    breakEvenStudents,
    cashInvested,
    paybackYears: L.owned && L.net > 0 && cashInvested > 0 ? cashInvested / L.net : null,
  };
}
