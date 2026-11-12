"use client";
import { useCallback, useEffect, useState } from "react";

type Item = {
  key: string;
  kind: string;
  what: string;
  where: string;
  reason: string;
  safe: boolean;
  unsafe_reason?: string;
};
type Report = { id: number; created_at: string; items: Item[] } | null;

const KIND_LABEL: Record<string, string> = {
  orphan_file: "Unused source files",
  junk: "Junk / temporary files",
  orphan_route: "Unreferenced API routes",
  empty_page: "Empty pages",
  duplicate_page: "Duplicate pages",
  stale_report: "Stale reports",
};

export default function WeeklyCleanupCard() {
  const [report, setReport] = useState<Report>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");

  const apply = (r: Report) => {
    setReport(r);
    setSelected(new Set((r?.items || []).filter((i) => i.safe).map((i) => i.key)));
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/cleanup");
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const d = await res.json();
      apply(d.report || null);
      setError("");
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function scan() {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/cleanup/scan", { method: "POST" });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      await load();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!report || !selected.size) return;
    const items = report.items.filter((i) => selected.has(i.key));
    const pages = items.filter((i) => i.key.startsWith("page:")).length;
    const files = items.length - pages;
    if (
      !window.confirm(
        `Delete ${items.length} selected item(s)?\n${pages} page(s) will go to Trash.\n${files} file(s) will go to an approval proposal (nothing is removed until approved).`
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch("/api/cleanup/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: report.id, keys: [...selected] }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.ok === false) throw new Error(d.error || `Status ${res.status}`);
      const results: { status: string }[] = d.results || [];
      setMessage(
        `${results.filter((r) => r.status === "archived").length} moved to Trash, ${results.filter((r) => r.status === "proposed").length} proposed for removal, ${results.filter((r) => r.status === "refused" || r.status === "skipped").length} skipped.`
      );
      setError("");
      await load();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(key: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }

  const groups = new Map<string, Item[]>();
  for (const i of report?.items || []) {
    if (!groups.has(i.kind)) groups.set(i.kind, []);
    groups.get(i.kind)!.push(i);
  }

  return (
    <section className="bg-panel border border-panel-border rounded-lg p-5 space-y-4" data-testid="weekly-cleanup-card">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg">Weekly cleanup</h2>
          <p className="text-sm text-muted">
            {report ? `Last scan: ${report.created_at}` : "Scans run Mondays at 6:00 AM Central. Nothing is deleted automatically."}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={scan} disabled={busy} className="px-3 py-1.5 text-sm border border-panel-border rounded-lg" data-testid="cleanup-scan">
            {busy ? "Working…" : "Run scan now"}
          </button>
          <button
            onClick={del}
            disabled={busy || !selected.size}
            className="px-3 py-1.5 text-sm border border-panel-border rounded-lg disabled:opacity-50"
            data-testid="cleanup-delete"
          >
            Delete selected ({selected.size})
          </button>
        </div>
      </div>
      {error && <div className="text-sm text-red-600" data-testid="cleanup-error">Something went wrong: {error}</div>}
      {message && <div className="text-sm text-muted">{message}</div>}
      {loaded && !error && (!report || report.items.length === 0) && (
        <div className="text-sm text-muted" data-testid="cleanup-empty">Nothing to clean up. Run a scan to check again.</div>
      )}
      {[...groups.entries()].map(([kind, items]) => (
        <div key={kind} className="space-y-2">
          <h3 className="text-sm font-medium">{KIND_LABEL[kind] || kind} ({items.length})</h3>
          <ul className="divide-y divide-panel-border border border-panel-border rounded-lg">
            {items.map((i) => (
              <li key={i.key} className="p-3 flex gap-3 items-start text-sm" data-testid="cleanup-item">
                <input
                  type="checkbox"
                  checked={selected.has(i.key)}
                  onChange={() => toggle(i.key)}
                  aria-label={`Select ${i.what}`}
                  className="mt-1"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium break-all">{i.what}</div>
                  <div className="text-muted break-all">{i.where}</div>
                  <div className="text-muted">
                    {i.reason}
                    {!i.safe && i.unsafe_reason ? ` — ${i.unsafe_reason}` : ""}
                  </div>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full border ${i.safe ? "border-green-600 text-green-700" : "border-amber-600 text-amber-700"}`}
                >
                  {i.safe ? "Safe" : "Unsafe"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
