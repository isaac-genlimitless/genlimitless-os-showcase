"use client";
// Live per-site economics. In a sandbox, input changes are saved to the sandbox; in canon they're
// a local what-if only (nothing is saved), with a reset.
import { useMemo, useRef, useState } from "react";
import { compute, normalizeInputs, SECTIONS, type InputDef, type InputKey, type Inputs, type Line } from "@/lib/creations/models/site-pnl";

const money = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M` : a >= 1e3 ? `$${Math.round(a / 1e3)}K` : `$${Math.round(a)}`;
  return n < 0 ? `−${s}` : s;
};
const pct = (n: number) => `${Math.round(n * 100)}%`;

function Tile({ label, value, sub, tone, testId }: { label: string; value: string; sub?: string; tone?: "good" | "bad"; testId?: string }) {
  return (
    <div className="rounded-xl border border-panel-border bg-panel p-3" data-testid={testId}>
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : ""}`}>
        {tone === "good" ? "▲ " : tone === "bad" ? "▼ " : ""}{value}
      </div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/** One single-series bar list: label + value as text, bar length = share of the larger side. */
function Bars({ title, lines, scale, tone }: { title: string; lines: Line[]; scale: number; tone: "in" | "out" }) {
  return (
    <div>
      <h4 className="text-xs uppercase tracking-wide text-muted mb-2">{title}</h4>
      <ul className="flex flex-col gap-2">
        {lines.map((l) => (
          <li key={l.key} className="text-sm" title={`${l.label}: ${money(l.amount)} / year`}>
            <div className="flex justify-between gap-2">
              <span>{l.label}{l.starlink && <span className="text-muted text-xs"> · engine</span>}</span>
              <span className="tabular-nums">{money(l.amount)}</span>
            </div>
            <div className="h-2 mt-1 rounded bg-wash-1">
              <div className={`h-2 rounded ${tone === "in" ? "bg-accent" : "bg-muted"}`} style={{ width: `${Math.max(1, (l.amount / scale) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Field({ d, value, onChange, disabled }: { d: InputDef; value: number; onChange: (v: number) => void; disabled: boolean }) {
  if (d.unit === "mode") {
    return (
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>Building</span>
        <select value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} data-testid={`input-${d.key}`}
          className="bg-transparent border border-panel-border rounded px-2 py-1">
          <option value={0}>Lease</option>
          <option value={1}>Own</option>
        </select>
      </label>
    );
  }
  return (
    <label className="flex flex-col gap-0.5 text-sm">
      <span className="flex justify-between gap-2">
        <span>{d.label}</span>
        <span className="text-xs text-muted">{d.unit === "$" ? "$" : d.unit === "%" ? "%" : d.unit === "sqft" ? "sq ft" : ""}</span>
      </span>
      <input type="number" value={value} min={d.min} max={d.max} step={d.step} disabled={disabled} data-testid={`input-${d.key}`}
        onChange={(e) => onChange(Number(e.target.value))}
        className="bg-transparent border border-panel-border rounded px-2 py-1 tabular-nums" />
      {d.note && <span className="text-[11px] text-muted">{d.note}</span>}
    </label>
  );
}

export default function ModelView({ data, editable, onSaveData }: {
  data: unknown;
  editable: boolean;
  onSaveData?: (data: unknown) => Promise<string | null>;
}) {
  const saved = useMemo(() => normalizeInputs((data as { inputs?: unknown } | null)?.inputs), [data]);
  const [inputs, setInputs] = useState<Inputs>(saved);
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const r = useMemo(() => compute(inputs), [inputs]);
  const dirty = JSON.stringify(inputs) !== JSON.stringify(saved);

  const set = (k: InputKey, v: number) => {
    const next = normalizeInputs({ ...inputs, [k]: Number.isFinite(v) ? v : 0 });
    setInputs(next);
    if (editable && onSaveData) {
      setStatus("Saving…");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        const err = await onSaveData({ engine: "site-pnl", inputs: next });
        setStatus(err ? err : "Saved to sandbox");
      }, 700);
    }
  };

  const scale = Math.max(r.totalRevenue, r.totalCost, 1);
  const owned = inputs.space_mode === 1;

  return (
    <div className="flex flex-col gap-5" data-testid="model-view">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {editable ? <span data-testid="model-status">{status || "Changes save to this sandbox."}</span> : (
          <>
            <span>Read-only here: changes are a what-if and are not saved.</span>
            {dirty && <button className="hover-pill" onClick={() => setInputs(saved)} data-testid="model-reset">Reset to canon</button>}
          </>
        )}
      </div>

      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
        <Tile testId="kpi-net" label="Net per year" value={money(r.net)} tone={r.net >= 0 ? "good" : "bad"} sub={`${pct(r.margin)} margin`} />
        <Tile testId="kpi-space" label="Engines cover the building" value={pct(r.spaceCoveredPct)} sub={`${money(r.starlinkRevenue)} of ${money(r.spaceCost)} / yr`} />
        <Tile testId="kpi-breakeven" label="Break-even drop-off students" value={r.breakEvenStudents === null ? "Never (≤2,000)" : String(r.breakEvenStudents)} sub={`now ${inputs.microschool_students}, ${r.facilitators} facilitators`} />
        <Tile testId="kpi-payback" label={owned ? "Payback on down payment" : "Cost per drop-off student"}
          value={owned ? (r.paybackYears === null ? "No payback" : `${r.paybackYears.toFixed(1)} yrs`) : money(r.costPerStudent)}
          sub={owned ? `${money(r.cashInvested)} down` : "per year"} />
      </div>

      <div className="grid md:grid-cols-2 gap-6 rounded-xl border border-panel-border p-4">
        <Bars title={`Money in · ${money(r.totalRevenue)} / yr`} lines={r.revenue} scale={scale} tone="in" />
        <Bars title={`Money out · ${money(r.totalCost)} / yr`} lines={r.costs} scale={scale} tone="out" />
      </div>

      <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
        {SECTIONS.map((s) => (
          <fieldset key={s.title} className="rounded-xl border border-panel-border p-3 flex flex-col gap-3">
            <legend className="text-xs uppercase tracking-wide text-muted px-1">{s.title}</legend>
            {s.inputs.filter((d) => !(owned && d.key === "lease_sqft_year") && !(!owned && ["purchase_price", "down_pct", "interest_pct", "loan_years"].includes(d.key))).map((d) => (
              <Field key={d.key} d={d} value={inputs[d.key]} onChange={(v) => set(d.key, v)} disabled={false} />
            ))}
          </fieldset>
        ))}
      </div>
    </div>
  );
}
