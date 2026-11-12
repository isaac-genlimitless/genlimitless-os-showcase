import { getState, setState, logIssue } from "./db";
import { logIssueOnce } from "./issue-once";
import { getQuickHealth, getServerHealth } from "./server-health";
import { alertDue } from "./server-health-core";

export async function checkServerHealthAlerts(now = Date.now()) {
  const quick = await getQuickHealth();
  for (const metric of ["memory", "disk"] as const) {
    try {
      const m = quick[metric];
      if (m.status !== "red") continue;
      const key = `server_health_alert:${metric}`;
      const raw = getState(key);
      const last = raw ? Number(raw) : null;
      if (!alertDue(last, now)) continue;
      const full = await getServerHealth();
      const top = full.sizes.topFolders[0];
      const topText = top ? `${top.path} (${(top.bytes / 1024 ** 3).toFixed(1)} GB)` : "unknown";
      logIssueOnce("server-health", `Server ${metric} usage is above 90%`, {
        pct: m.pct,
        topFolders: full.sizes.topFolders,
        hints: full.hints,
      });
      const { notifyOwner } = await import("./delivery");
      const result: any = await notifyOwner({
        message: `Server ${metric} is at ${m.pct}% (over 90%). Biggest folder: ${topText}. Details: Settings > Server health. Issue logged; only old release folders are ever deleted automatically.`,
        reason: "server_health",
      });
      if (result?.status !== "throttled") setState(key, String(now));
    } catch (err: any) {
      logIssue("scheduler:server_health", `Server ${metric} alert check failed`, err?.message);
    }
  }
}
