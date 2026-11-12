"use client";

import { useCallback, useEffect, useState } from "react";

type Status = "green" | "yellow" | "red";
const COLOR: Record<Status, string> = {
  green: "text-green-600",
  yellow: "text-yellow-600",
  red: "text-red-600",
};
const BG: Record<Status, string> = {
  green: "bg-green-600",
  yellow: "bg-yellow-600",
  red: "bg-red-600",
};

function bytes(n: number | null | undefined) {
  if (n == null) return "not available";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function dur(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function Tile({ id, title, status, pct, children }: { id: string; title: string; status: Status; pct?: number; children: React.ReactNode }) {
  return (
    <div className="border border-panel-border rounded-md p-3 space-y-1" data-testid={id} data-status={status}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className={`inline-block w-2 h-2 rounded-full ${BG[status]}`} />
        <span>{title}</span>
        {pct != null && <span className={`ml-auto ${COLOR[status]}`}>{pct}%</span>}
      </div>
      {pct != null && (
        <div className="h-1.5 bg-black/10 rounded">
          <div className={`h-1.5 rounded ${BG[status]}`} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
      <div className="text-xs opacity-80">{children}</div>
    </div>
  );
}

export default function ServerHealthCard() {
  const [h, setH] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/server-health", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setH(j);
      setErr(null);
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 30000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <section className="bg-panel border border-panel-border rounded-lg p-5 space-y-4" data-testid="server-health-card">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">Server health</h2>
        {h && (
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded border border-panel-border ${COLOR[h.overall as Status]}`}
            data-testid="server-health-overall"
            data-status={h.overall}
          >
            {h.overall}
          </span>
        )}
        <button onClick={load} className="ml-auto text-sm border border-panel-border rounded px-3 py-1">
          Refresh
        </button>
      </div>

      {err && <p className="text-sm text-red-600">Couldn&apos;t read server health: {err}</p>}
      {!h && !err && <p className="text-sm opacity-70">Loading...</p>}

      {h && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Tile id="health-memory" title="Memory" status={h.memory.status} pct={h.memory.pct}>
              {bytes(h.memory.used)} of {bytes(h.memory.total)} used
            </Tile>
            <Tile id="health-disk" title="Disk" status={h.disk.status} pct={h.disk.pct}>
              {bytes(h.disk.used)} of {bytes(h.disk.total)} used, {bytes(h.disk.free)} free
            </Tile>
            <Tile id="health-cpu" title="CPU load" status={h.cpu.status} pct={h.cpu.pct}>
              {h.cpu.load1.toFixed(2)} / {h.cpu.load5.toFixed(2)} / {h.cpu.load15.toFixed(2)} (1/5/15 min), {h.cpu.cores} cores
            </Tile>
            <Tile id="health-uptime" title="Uptime" status="green">
              Server {dur(h.uptime.serverSeconds)}, app process {dur(h.uptime.processSeconds)}
            </Tile>
          </div>

          <p className="text-sm">
            <span className="font-medium">Node process:</span> RSS {bytes(h.nodeProcess.rss)}, heap {bytes(h.nodeProcess.heapUsed)} /{" "}
            {bytes(h.nodeProcess.heapTotal)}, {h.nodeProcess.rssPctOfRam}% of RAM
          </p>

          <div className="text-sm space-y-1">
            <div className="font-medium">Folder sizes</div>
            <div>OS folder: {bytes(h.sizes.osRoot)}</div>
            <div>Data folder: {bytes(h.sizes.data)}</div>
            <div>Releases folder: {bytes(h.sizes.releases)}</div>
          </div>

          {h.releaseCleanup && (
            <div className="text-sm space-y-1" data-testid="release-cleanup">
              <div className="font-medium">Old releases cleaned up</div>
              {h.releaseCleanup.last ? (
                <>
                  <div>
                    Last run: {new Date(h.releaseCleanup.last.at).toLocaleString()} ({h.releaseCleanup.last.trigger})
                  </div>
                  {h.releaseCleanup.last.skippedReason && (
                    <div className="text-danger">Skipped: {h.releaseCleanup.last.skippedReason}</div>
                  )}
                  {h.releaseCleanup.last.removed.length ? (
                    <>
                      <ul className="list-disc ml-5">
                        {h.releaseCleanup.last.removed.map((r: any) => (
                          <li key={r.name}>
                            {r.name}: {bytes(r.bytes)}
                          </li>
                        ))}
                      </ul>
                      <div className="font-bold" data-testid="release-cleanup-freed">
                        Freed {bytes(h.releaseCleanup.last.freedBytes)}
                      </div>
                    </>
                  ) : (
                    <div>Nothing to remove</div>
                  )}
                </>
              ) : (
                <div>Has not run yet</div>
              )}
              <div>Total freed so far: {bytes(h.releaseCleanup.totalFreedBytes)}</div>
              <div className="text-xs opacity-70">
                Keeps the running release, the previous one (rollback) and the newest 3. Only release folders are ever removed.
              </div>
            </div>
          )}

          <div className="text-sm">
            <div className="font-medium">What&apos;s using space</div>
            <ol className="list-decimal ml-5" data-testid="health-top-folders">
              {(h.sizes.topFolders || []).map((f: any) => (
                <li key={f.path}>
                  {f.path}: {bytes(f.bytes)}
                </li>
              ))}
            </ol>
          </div>

          <div className="text-sm">
            <div className="font-medium">Suggestions (display only)</div>
            <ul className="list-disc ml-5">
              {(h.hints || []).length === 0 ? <li>None right now.</li> : h.hints.map((t: string, i: number) => <li key={i}>{t}</li>)}
            </ul>
          </div>
        </>
      )}

      <p className="text-xs opacity-70">
        Thresholds: yellow above 75%, red above 90%. Alerts text Owner at most once per 12 hours per metric.
      </p>
    </section>
  );
}
