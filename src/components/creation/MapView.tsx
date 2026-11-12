"use client";
// Structure map: columns of parts. Click a part to see what it connects to (in and out).
import { useMemo, useState } from "react";
import type { StructureMap } from "@/lib/creations/models/structure-map";

export default function MapView({ data }: { data: unknown }) {
  const map = data as StructureMap;
  const [focus, setFocus] = useState<string | null>(null);
  const labels = useMemo(() => new Map(map.columns.flatMap((c) => c.nodes.map((n) => [n.id, n.label] as const))), [map]);
  const linked = useMemo(() => {
    if (!focus) return null;
    const s = new Set<string>([focus]);
    for (const e of map.edges) {
      if (e.from === focus) s.add(e.to);
      if (e.to === focus) s.add(e.from);
    }
    return s;
  }, [focus, map]);
  const out = focus ? map.edges.filter((e) => e.from === focus) : [];
  const inc = focus ? map.edges.filter((e) => e.to === focus) : [];

  if (!Array.isArray(map?.columns)) return <p className="text-sm text-muted">This map is empty.</p>;

  return (
    <div className="flex flex-col gap-4" data-testid="map-view">
      <div className="grid gap-x-3 gap-y-5 grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]">
        {map.columns.map((c) => (
          <section key={c.title} className="flex flex-col gap-2">
            <h4 className="text-xs uppercase tracking-wide text-muted">{c.title}</h4>
            {c.nodes.map((n) => {
              const on = focus === n.id;
              const dim = linked && !linked.has(n.id);
              return (
                <button key={n.id} onClick={() => setFocus(on ? null : n.id)} data-testid={`map-node-${n.id}`} aria-pressed={on}
                  className={`text-left text-sm rounded-lg border px-2.5 py-2 transition-opacity ${on ? "border-gold bg-gold-soft" : linked?.has(n.id) ? "border-accent" : "border-panel-border bg-panel"} ${dim ? "opacity-35" : ""}`}>
                  {n.label}
                </button>
              );
            })}
          </section>
        ))}
      </div>
      {focus ? (
        <div className="rounded-xl border border-panel-border p-3 text-sm flex flex-col gap-2" data-testid="map-detail">
          <div className="font-semibold">{labels.get(focus)}</div>
          {map.columns.flatMap((c) => c.nodes).find((n) => n.id === focus)?.notes && (
            <p className="text-muted">{map.columns.flatMap((c) => c.nodes).find((n) => n.id === focus)?.notes}</p>
          )}
          {out.length > 0 && <ul>{out.map((e, i) => <li key={i}>→ {e.label ? `${e.label}: ` : ""}<b>{labels.get(e.to)}</b></li>)}</ul>}
          {inc.length > 0 && <ul>{inc.map((e, i) => <li key={i}>← <b>{labels.get(e.from)}</b>{e.label ? ` ${e.label}` : ""}</li>)}</ul>}
          {!out.length && !inc.length && <p className="text-muted">No connections yet.</p>}
        </div>
      ) : (
        <p className="text-xs text-muted">Click any part to see what it connects to.</p>
      )}
    </div>
  );
}
