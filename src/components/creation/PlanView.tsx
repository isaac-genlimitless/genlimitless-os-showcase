"use client";
// Site prototype: numbers, a 2D plan (or the 3D view), and the 24×7 utilization clock.
import { useMemo, useState } from "react";
import { layoutPlan, USE_COLOR, USE_LABEL, USES, utilization, type SitePlan } from "@/lib/creations/models/site-plan";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pct = (n: number) => `${Math.round(n * 100)}%`;
const fmt = (n: number) => Math.round(n).toLocaleString();
const hourLabel = (h: number) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);

function Tile({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId?: string }) {
  return (
    <div className="rounded-xl border border-panel-border bg-panel p-3" data-testid={testId}>
      <div className="text-xs text-muted">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function Plan2D({ plan }: { plan: SitePlan }) {
  const L = useMemo(() => layoutPlan(plan), [plan]);
  const used = new Set(L.rects.map((r) => r.use));
  // One readable label size for the whole lot; labels are shortened to their block (full names are in the table and tooltips).
  const fs = Math.max(L.lot.w, L.lot.d) / 45;
  const fit = (label: string, w: number) => {
    const max = Math.floor(w / (fs * 0.55));
    return label.length > max ? label.slice(0, Math.max(1, max - 1)) + "…" : label;
  };
  return (
    <figure className="flex flex-col gap-2" data-testid="plan-2d">
      <svg viewBox={`-10 -10 ${L.lot.w + 20} ${L.lot.d + 20}`} className="w-full max-h-[60vh] rounded-lg border border-panel-border bg-wash-1" role="img"
        aria-label={`Site plan on ${plan.lot_acres} acres: ${L.rects.map((r) => r.label).join(", ")}`}>
        <rect x={0} y={0} width={L.lot.w} height={L.lot.d} fill="none" stroke="currentColor" strokeOpacity={0.35} strokeDasharray="6 6" />
        <rect x={L.building.x - 3} y={L.building.y - 3} width={L.building.w + 6} height={L.building.d + 6} rx={6} fill="none" stroke="currentColor" strokeOpacity={0.6} />
        {L.rects.map((r) => (
          <g key={r.id}>
            <title>{`${r.label} · ${fmt(r.w * r.d)} sq ft`}</title>
            <rect x={r.x + 1} y={r.y + 1} width={Math.max(1, r.w - 2)} height={Math.max(1, r.d - 2)} rx={4} fill={USE_COLOR[r.use]} fillOpacity={r.indoor ? 0.9 : 0.45} />
            {r.w > fs * 3 && (
              <text x={r.x + r.w / 2} y={r.y + r.d / 2} textAnchor="middle" dominantBaseline="middle" fontSize={fs} fill="currentColor">
                {fit(r.label, r.w)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {USES.filter((u) => used.has(u)).map((u) => (
          <span key={u} className="inline-flex items-center gap-1.5"><i className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: USE_COLOR[u] }} />{USE_LABEL[u]}</span>
        ))}
        <span>Lot: {plan.lot_acres} acres (dashed){L.fits ? "" : " · ⚠ doesn't fit as laid out"}</span>
      </figcaption>
    </figure>
  );
}

function Clock({ grid }: { grid: number[][] }) {
  // Sequential single hue (blue), light → dark. 0 = empty.
  const shade = (v: number) => (v <= 0 ? "transparent" : `color-mix(in oklab, #2a78d6 ${Math.round(15 + v * 85)}%, transparent)`);
  return (
    <figure className="flex flex-col gap-2" data-testid="plan-clock">
      <div className="overflow-x-auto">
        <table className="text-[10px] border-separate" style={{ borderSpacing: 2 }}>
          <thead>
            <tr><th />{Array.from({ length: 24 }, (_, h) => <th key={h} className="font-normal text-muted w-5">{h % 3 === 0 ? hourLabel(h) : ""}</th>)}</tr>
          </thead>
          <tbody>
            {grid.map((row, d) => (
              <tr key={d}>
                <th className="font-normal text-muted pr-1 text-right">{DAYS[d]}</th>
                {row.map((v, h) => (
                  <td key={h} title={`${DAYS[d]} ${hourLabel(h)}–${hourLabel((h + 1) % 24)}: ${pct(v)} of indoor space in use`}
                    className="w-5 h-5 rounded-[3px] border border-panel-border" style={{ background: shade(v) }} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="flex items-center gap-2 text-xs text-muted">
        Share of indoor space in use: <span>0%</span>
        <span className="inline-block h-2.5 w-24 rounded" style={{ background: "linear-gradient(90deg, color-mix(in oklab, #2a78d6 15%, transparent), #2a78d6)" }} />
        <span>100%</span> · hover a cell for the exact number
      </figcaption>
    </figure>
  );
}

export default function PlanView({ data, sourceRef, artifactKey, apiBase = "/api/creations" }: { data: unknown; sourceRef: string | null; artifactKey: string; apiBase?: string }) {
  const plan = data as SitePlan;
  const u = useMemo(() => utilization(plan), [plan]);
  const [view, setView] = useState<"2d" | "3d">("2d");
  const src = sourceRef ? `${apiBase}/site3d/${sourceRef}/${artifactKey}` : null;
  const maxWho = Math.max(1, ...u.byWho.map((w) => w.sqftHours));

  return (
    <div className="flex flex-col gap-5" data-testid="plan-view">
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
        <Tile testId="plan-sqft" label="Building" value={`${fmt(u.indoorSqft)} sq ft`} sub={`${pct(u.coverage)} of a ${plan.lot_acres}-acre lot`} />
        <Tile testId="plan-util" label="Building in use (24×7)" value={pct(u.weekly)} sub={`school hours alone: ${pct(u.schoolHoursOnly)}`} />
        <Tile label="Outdoor / farm" value={`${(u.outdoorSqft / 43560).toFixed(1)} acres`} />
        <Tile label="Programs using it" value={String(u.byWho.length)} />
      </div>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h4 className="text-xs uppercase tracking-wide text-muted flex-1">Site plan</h4>
          <div role="tablist" className="flex gap-1 text-xs">
            <button role="tab" aria-selected={view === "2d"} onClick={() => setView("2d")} data-testid="plan-tab-2d" className={`px-2 py-1 rounded ${view === "2d" ? "bg-wash-2 text-accent" : "hover-pill"}`}>2D plan</button>
            <button role="tab" aria-selected={view === "3d"} onClick={() => setView("3d")} data-testid="plan-tab-3d" disabled={!src} className={`px-2 py-1 rounded ${view === "3d" ? "bg-wash-2 text-accent" : "hover-pill"} disabled:opacity-40`}>3D</button>
          </div>
          {src && <a href={src} target="_blank" rel="noopener noreferrer" className="hover-pill text-xs">Open 3D full screen ↗</a>}
        </div>
        {view === "2d" || !src ? <Plan2D plan={plan} /> : (
          <iframe title="Site plan in 3D" src={src} sandbox="allow-scripts" data-testid="plan-3d-frame" className="w-full h-[60vh] rounded-lg border border-panel-border bg-wash-1" />
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-xs uppercase tracking-wide text-muted">Utilization clock: who uses the building when</h4>
        <Clock grid={u.grid} />
      </section>

      <section>
        <h4 className="text-xs uppercase tracking-wide text-muted mb-2">Square-foot hours per week, by program</h4>
        <ul className="flex flex-col gap-2 max-w-xl">
          {u.byWho.map((w) => (
            <li key={w.who} className="text-sm" title={`${w.who}: ${fmt(w.sqftHours)} sq-ft-hours / week`}>
              <div className="flex justify-between"><span>{w.who}</span><span className="tabular-nums text-muted">{fmt(w.sqftHours)}</span></div>
              <div className="h-2 mt-1 rounded bg-wash-1"><div className="h-2 rounded bg-accent" style={{ width: `${(w.sqftHours / maxWho) * 100}%` }} /></div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="text-xs uppercase tracking-wide text-muted mb-2">Zones</h4>
        <table className="text-sm w-full max-w-3xl">
          <thead><tr className="text-left text-xs text-muted"><th className="font-normal py-1">Zone</th><th className="font-normal">Use</th><th className="font-normal text-right">Sq ft</th><th className="font-normal pl-4">Schedule</th></tr></thead>
          <tbody>
            {plan.zones.map((z) => (
              <tr key={z.id} className="border-t border-panel-border align-top">
                <td className="py-1.5">{z.label}</td>
                <td><span className="inline-flex items-center gap-1.5"><i className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: USE_COLOR[z.use] }} />{USE_LABEL[z.use]}</span></td>
                <td className="text-right tabular-nums">{fmt(z.sqft)}</td>
                <td className="pl-4 text-xs text-muted">{z.schedule.length ? z.schedule.map((s) => `${s.who}: ${s.days.map((d) => DAYS[d]).join("/")} ${hourLabel(s.start)}–${hourLabel(s.end % 24)}`).join(" · ") : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
