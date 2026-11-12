import { monitorEventLoopDelay } from "perf_hooks";

// The OS serves every page and runs every scheduler job in one Node process, so one slow synchronous
// job (a big SQLite query, a large JSON parse) freezes every page and button until it finishes.
// This logs a line whenever the process was frozen for over a second in the last minute, so the
// cause can be found in the server log (journalctl -u genlimitless-os | grep event-loop).
const WARN_MS = 1000;

export function startLoopLagMonitor(): void {
  const g = globalThis as { __loopLagStarted?: boolean };
  if (g.__loopLagStarted) return;
  g.__loopLagStarted = true;
  const h = monitorEventLoopDelay({ resolution: 50 });
  h.enable();
  const t = setInterval(() => {
    const maxMs = Math.round(h.max / 1e6);
    if (maxMs >= WARN_MS) {
      console.warn(`[event-loop] server was frozen for up to ${maxMs}ms in the last minute (p99 ${Math.round(h.percentile(99) / 1e6)}ms)`);
    }
    h.reset();
  }, 60_000);
  t.unref();
}
