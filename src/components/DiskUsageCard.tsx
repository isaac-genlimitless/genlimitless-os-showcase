"use client";

import { useCallback, useEffect, useState } from "react";

function bytes(n: number | null | undefined) {
  if (n == null) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "?";

export default function DiskUsageCard() {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (fresh = false) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/disk-usage${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setD(j); setErr(null);
    } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <section className="bg-panel border border-panel-border rounded-lg p-5 space-y-3" data-testid="disk-usage-card">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">Disk usage</h2>
        <span className="text-xs opacity-70">Read-only. Nothing here deletes anything.</span>
        <button className="ml-auto text-xs underline disabled:opacity-50" onClick={() => load(true)} disabled={busy} data-testid="disk-usage-refresh">
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>
      {err && <div className="text-sm text-red-600">Couldn&apos;t load disk usage: {err}</div>}
      {d && (
        <>
          <div className="text-sm" data-testid="disk-usage-releases">
            Running: <b>{d.runningRelease || "?"}</b> · Current: <b>{d.currentRelease || "?"}</b> · Previous: <b>{d.previousRelease || "none"}</b>
          </div>
          {d.folders.map((f: any) => (
            <details key={f.folder} className="border border-panel-border rounded-md p-2" data-testid="disk-usage-folder" data-folder={f.folder}>
              <summary className="cursor-pointer text-sm">
                <b>{f.folder}</b> · {f.exists ? `${bytes(f.totalBytes)} · ${f.entryCount} item${f.entryCount === 1 ? "" : "s"}` : f.error ? `can't read (${f.error})` : "not present"}
              </summary>
              {f.entries.length > 0 && (
                <div className="overflow-x-auto">
                <table className="w-full text-xs mt-2 break-words">
                  <thead><tr className="text-left opacity-70"><th>Name</th><th className="text-right">Size</th><th className="px-2">Modified (CT)</th><th>Notes</th></tr></thead>
                  <tbody>
                    {f.entries.map((e: any) => (
                      <tr key={e.name} data-testid="disk-usage-entry">
                        <td className="font-mono break-all">{e.name}{e.type === "dir" ? "/" : e.type === "link" ? " →" : ""}</td>
                        <td className="text-right whitespace-nowrap">{bytes(e.bytes)}</td>
                        <td className="whitespace-nowrap px-2">{when(e.modified)}</td>
                        <td>{e.tags.join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
              {f.truncated && <div className="text-xs opacity-70 mt-1">Showing the newest 300 of {f.entryCount}.</div>}
            </details>
          ))}
        </>
      )}
    </section>
  );
}
