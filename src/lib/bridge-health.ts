import fs from "fs";
import path from "path";
import { DATA_DIR } from "./data-dir";
import { MIRROR_MODE, bridgeHeartbeatAgeMinutes, mirrorAgeMinutes } from "./imessage";
import { resolveIssuesBySource, upsertOpenIssue } from "./issue-once";
import { sendEmail } from "./mail-accounts";

// Watches the Mac iMessage bridge heartbeat (.last-sync, touched by bridge/imessage-sync.sh).
// One outage = one self-resolving issue and NO email or text is sent (disabled by Owner 10/24).
// Heartbeat = the freshest of the send worker's poll (.bridge-heartbeat) and .last-sync
// (which only changes when Messages gets new texts, so it alone goes stale on an idle Mac).

export const ISSUE_SOURCE = "bridge_health";
const OFFLINE_AFTER_MIN = 15;
const STATE_FILE = path.join(DATA_DIR, "bridge-health.json");

export type BridgeStatus = {
  applicable: boolean;
  online: boolean;
  lastSyncAt: string | null;
  ageMin: number | null;
  offlineSince: string | null;
};

type State = { offlineSince: string; alertedAt: number | null; recoveredAt?: number };

const ALERT_HOLD_GRACE_MS = 10 * 60_000;

/** True while queued alert texts should wait for the Mac: bridge offline, or back for less than 10 min. */
export function bridgeAlertHoldActive(nowMs: number = Date.now()): boolean {
  const status = bridgeStatus(nowMs);
  if (!status.applicable) return false;
  if (!status.online) return true;
  const rec = readState()?.recoveredAt;
  return typeof rec === "number" && nowMs - rec < ALERT_HOLD_GRACE_MS;
}

function readState(): State | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}
function writeState(s: State | null) {
  try {
    if (s) fs.writeFileSync(STATE_FILE, JSON.stringify(s));
    else fs.writeFileSync(STATE_FILE, "{}"); // cleared (files are never deleted)
  } catch {}
}

export function bridgeStatus(nowMs: number = Date.now()): BridgeStatus {
  if (!MIRROR_MODE) return { applicable: false, online: true, lastSyncAt: null, ageMin: null, offlineSince: null };
  const ages = [mirrorAgeMinutes(), bridgeHeartbeatAgeMinutes()].filter((n): n is number => n !== null);
  const ageMin = ages.length ? Math.min(...ages) : null;
  const online = ageMin !== null && ageMin <= OFFLINE_AFTER_MIN;
  const lastSyncAt = ageMin === null ? null : new Date(nowMs - ageMin * 60_000).toISOString();
  const saved = readState();
  return {
    applicable: true,
    online,
    lastSyncAt,
    ageMin: ageMin === null ? null : Math.round(ageMin),
    offlineSince: online ? null : saved?.offlineSince || lastSyncAt,
  };
}

const ct = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });

/** Every 5 min (via runMailHealthProbe). emailFn/status injectable for tests. */
export async function checkBridgeHealth(
  nowMs: number = Date.now(),
  emailFn: typeof sendEmail = sendEmail,
  status: BridgeStatus = bridgeStatus(nowMs)
) {
  if (!status.applicable) return;
  const state = readState();
  if (status.online) {
    if (state?.offlineSince) {
      resolveIssuesBySource(ISSUE_SOURCE, "bridge recovered");
      writeState({ offlineSince: "", alertedAt: null, recoveredAt: nowMs });
    }
    return;
  }
  const offlineSince = state?.offlineSince || status.lastSyncAt || new Date(nowMs).toISOString();
  const label = status.lastSyncAt ? ct(status.lastSyncAt) : `unknown (no heartbeat found; first noticed ${ct(offlineSince)})`;
  upsertOpenIssue(ISSUE_SOURCE, `Mac bridge offline since ${label}`, { ageMin: status.ageMin });
  // emailFn is unused: bridge-down email disabled by Owner 10/24; status is still logged.
  void emailFn;
  writeState({ offlineSince, alertedAt: state?.alertedAt ?? null });
}
