import cron from "node-cron";
import { runScan } from "./cleanup-scan";

// Weekly cleanup scan: Mondays 06:00 Central. Only stores a pending report; deletes/sends nothing.
export function startCleanupCron() {
  const g = globalThis as { __cleanupCronStarted?: boolean };
  if (g.__cleanupCronStarted) return;
  g.__cleanupCronStarted = true;
  cron.schedule(
    "0 6 * * 1",
    () => {
      try {
        runScan();
      } catch (e) {
        console.error("weekly cleanup scan failed", e);
      }
    },
    { timezone: "America/Chicago" }
  );
}
