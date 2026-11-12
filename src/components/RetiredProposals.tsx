"use client";
import { useCallback, useEffect, useState } from "react";

type Retired = { kind: "email" | "text" | "calendar"; id: number; title: string; why: string; status: string; created_at: string };
const KIND: Record<Retired["kind"], string> = { email: "Email", text: "Text", calendar: "Calendar" };

export default function RetiredProposals({ onChange }: { onChange?: () => void }) {
  const [items, setItems] = useState<Retired[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/decisions/retired", { cache: "no-store" });
      const d = await r.json();
      setItems(Array.isArray(d.items) ? d.items : []);
    } catch {
      /* keep the last list */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function restore(i: Retired) {
    const key = `${i.kind}:${i.id}`;
    setBusy(key);
    setError(null);
    try {
      const r = await fetch("/api/decisions/retired", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: i.kind, id: i.id }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Couldn't put it back.");
      onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      await load();
    }
  }

  return (
    <details data-testid="retired-panel" className="bg-panel border border-panel-border rounded">
      <summary className="px-4 py-3 text-sm cursor-pointer max-md:min-h-11">Recently retired ({items.length})</summary>
      <div className="px-4 pb-4 space-y-2">
        <p className="text-xs text-muted">Drafts and calendar blocks the OS retired on its own. Put back returns one to your queue; it never sends anything.</p>
        {error && <div role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">{error}</div>}
        {items.length === 0 && <div className="text-sm text-muted">Nothing retired in the last 14 days.</div>}
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={`${i.kind}:${i.id}`} data-testid="retired-row" className="flex flex-wrap md:flex-nowrap items-start gap-3 px-4 py-3 bg-panel border border-panel-border rounded">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs px-2 py-0.5 rounded-full border border-panel-border text-muted">{KIND[i.kind]}</span>
                  <span className="text-sm [overflow-wrap:anywhere]">{i.title}</span>
                </div>
                <div className="text-xs text-muted mt-1 [overflow-wrap:anywhere]">{i.why}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2 max-md:basis-full">
                <button
                  data-testid="retired-restore"
                  className="px-3 py-1 text-sm rounded border border-accent text-accent max-md:min-h-11 max-md:px-4"
                  disabled={busy === `${i.kind}:${i.id}`}
                  onClick={() => restore(i)}
                >
                  Put back
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
