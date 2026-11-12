"use client";
// Site finder: ranked candidates with adjustable weights. Canon = what-if only; sandbox = weights autosave.
import { useMemo, useRef, useState } from "react";
import { normalizeSites, rankSites, type SiteFinder } from "@/lib/creations/models/site-finder";

export default function SitesView({ data, editable, onSaveData }: { data: unknown; editable: boolean; onSaveData?: (d: unknown) => Promise<string | null> }) {
  const saved = useMemo(() => normalizeSites(data), [data]);
  const [finder, setFinder] = useState<SiteFinder>(saved);
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ranked = useMemo(() => rankSites(finder), [finder]);
  const dirty = JSON.stringify(finder.criteria) !== JSON.stringify(saved.criteria);

  const setWeight = (key: string, w: number) => {
    const next = { ...finder, criteria: finder.criteria.map((c) => (c.key === key ? { ...c, weight: w } : c)) };
    setFinder(next);
    if (editable && onSaveData) {
      setStatus("Saving…");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => setStatus((await onSaveData(next)) ?? "Saved to sandbox"), 600);
    }
  };

  return (
    <div className="flex flex-col gap-5" data-testid="sites-view">
      <div className="text-xs text-muted flex gap-2 items-center">
        {editable ? <span data-testid="sites-status">{status || "Weights save to this sandbox. Use Edit to add candidates or change scores."}</span> : (
          <>
            <span>Read-only here: weight changes are a what-if and are not saved.</span>
            {dirty && <button className="hover-pill" onClick={() => setFinder(saved)} data-testid="sites-reset">Reset to canon</button>}
          </>
        )}
      </div>

      <ol className="flex flex-col gap-2" data-testid="sites-ranking">
        {ranked.map((r, i) => (
          <li key={r.candidate.id} className="rounded-xl border border-panel-border bg-panel p-3" data-testid={`site-${r.candidate.id}`}>
            <button className="w-full text-left" onClick={() => setOpen(open === r.candidate.id ? null : r.candidate.id)}>
              <div className="flex items-baseline gap-3">
                <span className="text-muted tabular-nums w-5">{i + 1}.</span>
                <span className="font-medium flex-1">{r.candidate.name} <span className="text-xs text-muted">· {r.candidate.kind}</span></span>
                <span className="tabular-nums font-semibold" data-testid="site-score">{r.score === null ? "—" : r.score.toFixed(1)}</span>
                <span className="text-xs text-muted w-24 text-right">{Math.round(r.known * 100)}% of weight known</span>
              </div>
              <div className="h-2 mt-2 ml-8 rounded bg-wash-1"><div className="h-2 rounded bg-accent" style={{ width: `${((r.score ?? 0) / 10) * 100}%` }} /></div>
            </button>
            {open === r.candidate.id && (
              <div className="mt-3 ml-8 text-sm flex flex-col gap-2">
                {r.candidate.notes && <p className="text-muted">{r.candidate.notes}</p>}
                <table className="text-xs">
                  <tbody>
                    {finder.criteria.map((c) => (
                      <tr key={c.key}><td className="pr-3 py-0.5">{c.label}</td><td className="tabular-nums">{r.candidate.scores[c.key] ?? <span className="text-muted">unknown</span>}</td></tr>
                    ))}
                  </tbody>
                </table>
                {r.candidate.sources.length > 0 && (
                  <div className="text-xs">Sources: {r.candidate.sources.map((s, j) => (
                    <a key={s} href={s} target="_blank" rel="noopener noreferrer" className="underline mr-2">[{j + 1}] {new URL(s).hostname}</a>
                  ))}</div>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>

      <fieldset className="rounded-xl border border-panel-border p-3 flex flex-col gap-2 max-w-xl">
        <legend className="text-xs uppercase tracking-wide text-muted px-1">How much each thing matters (0–5)</legend>
        {finder.criteria.map((c) => (
          <label key={c.key} className="flex items-center gap-3 text-sm">
            <span className="flex-1">{c.label}</span>
            <input type="range" min={0} max={5} step={1} className="accent-accent" value={c.weight} onChange={(e) => setWeight(c.key, Number(e.target.value))} data-testid={`weight-${c.key}`} />
            <span className="w-4 tabular-nums">{c.weight}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
