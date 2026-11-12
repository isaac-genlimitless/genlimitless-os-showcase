import { test, expect } from "./isolated-test";
import { checkBridgeHealth, type BridgeStatus } from "../src/lib/bridge-health";
import { openTestDb } from "./db-handle";
import fs from "fs";
import path from "path";

// Never presses Send or triggers an agent.
const body = (online: boolean) =>
  JSON.stringify({ applicable: true, online, lastSyncAt: "2026-10-20T12:00:00Z", ageMin: online ? 1 : 90, offlineSince: online ? null : "2026-10-20T12:00:00Z" });

test("banner shows when the bridge is offline", async ({ page }) => {
  await page.route("**/api/bridge-status", (r) => r.fulfill({ contentType: "application/json", body: body(false) }));
  await page.goto("/");
  await expect(page.getByTestId("bridge-banner")).toBeVisible();
  await expect(page.getByTestId("bridge-banner")).toContainText("Mac bridge offline since");
});

test("banner absent when the bridge is online", async ({ page }) => {
  await page.route("**/api/bridge-status", (r) => r.fulfill({ contentType: "application/json", body: body(true) }));
  await page.goto("/");
  await expect(page.getByTestId("bridge-banner")).toHaveCount(0);
});

const bodyAt = (online: boolean, offlineSince: string | null) =>
  JSON.stringify({ applicable: true, online, lastSyncAt: null, ageMin: online ? 1 : 5, offlineSince });

test("offline banner is in flow and does not overlap the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/bridge-status", (r) => r.fulfill({ contentType: "application/json", body: body(false) }));
  await page.goto("/");
  const banner = page.getByTestId("bridge-banner");
  await expect(banner).toBeVisible();
  const bb = (await banner.boundingBox())!;
  const aside = page.locator("aside[data-app-nav]");
  const ab = (await aside.boundingBox())!;
  expect(bb.y).toBe(0);
  expect(ab.y).toBeGreaterThanOrEqual(bb.y + bb.height - 1);
  const link = aside.locator("a").first();
  await expect(link).toBeVisible();
  const lb = (await link.boundingBox())!;
  const inside = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest("aside[data-app-nav]"),
    [lb.x + lb.width / 2, lb.y + lb.height / 2],
  );
  expect(inside).toBe(true);
});

test("mobile: header sits below the banner", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.route("**/api/bridge-status", (r) => r.fulfill({ contentType: "application/json", body: body(false) }));
  await page.goto("/");
  const banner = page.getByTestId("bridge-banner");
  await expect(banner).toBeVisible();
  const bb = (await banner.boundingBox())!;
  const hb = (await page.locator("header[data-app-nav]").boundingBox())!;
  expect(hb.y).toBeGreaterThanOrEqual(bb.y + bb.height - 1);
  await page.locator("header[data-app-nav] button").first().click({ trial: true });
});

test("banner updates live without reload and flashes recovery", async ({ page }) => {
  let online = false;
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  await page.route("**/api/bridge-status", (r) =>
    r.fulfill({ contentType: "application/json", body: online ? bodyAt(true, null) : bodyAt(false, since) }),
  );
  await page.goto("/");
  const banner = page.getByTestId("bridge-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("offline for 5 min");
  online = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const rec = page.getByTestId("bridge-banner-recovered");
  await expect(rec).toBeVisible();
  await expect(rec).toContainText("back online");
  await expect(rec).toBeHidden({ timeout: 8000 });
});

test("banner appears live when the bridge goes offline", async ({ page }) => {
  let online = true;
  await page.route("**/api/bridge-status", (r) =>
    r.fulfill({ contentType: "application/json", body: online ? body(true) : body(false) }),
  );
  await page.goto("/");
  await expect(page.getByTestId("bridge-banner")).toHaveCount(0);
  online = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByTestId("bridge-banner")).toBeVisible();
});

test.describe("bridgeStatus uses worker heartbeat", () => {
  const mirror = process.env.IMESSAGE_MIRROR_DIR || "";
  const dataDir = process.env.GENLIMITLESS_DATA_DIR || "";
  const set = (file: string, ageMin: number | null) => {
    if (ageMin === null) {
      try { fs.writeFileSync(file, "{}"); fs.utimesSync(file, new Date(0), new Date(0)); } catch {}
      return;
    }
    fs.writeFileSync(file, "x");
    const t = new Date(Date.now() - ageMin * 60_000);
    fs.utimesSync(file, t, t);
  };

  test("A/B/C: online decision", async () => {
    test.skip(!mirror || !dataDir, "needs mirror mode with an isolated data dir");
    const { bridgeStatus } = await import("../src/lib/bridge-health");
    const sync = path.join(mirror, ".last-sync");
    const hb = path.join(dataDir, ".bridge-heartbeat");
    set(sync, 180); set(hb, 0.1);
    expect(bridgeStatus().online).toBe(true); // A
    set(sync, 180); set(hb, 180);
    expect(bridgeStatus().online).toBe(false); // B
    set(sync, 1); set(hb, 180);
    expect(bridgeStatus().online).toBe(true); // C-ish: fresh sync still counts
  });
});

test("checkBridgeHealth logs one issue per outage, sends no email, resolves on recovery", async () => {
  const off: BridgeStatus = { applicable: true, online: false, lastSyncAt: "2026-10-20T12:00:00.000Z", ageMin: 90, offlineSince: null };
  const on: BridgeStatus = { applicable: true, online: true, lastSyncAt: null, ageMin: 1, offlineSince: null };
  let sent = 0;
  const fake = (async () => {
    sent++;
    return {};
  }) as any;
  const now = Date.now();
  await checkBridgeHealth(now, fake, off);
  await checkBridgeHealth(now + 5 * 60_000, fake, off);
  expect(sent).toBe(0);
  const db = openTestDb();
  try {
    const open = db.prepare(`SELECT COUNT(*) AS n FROM issues WHERE source='bridge_health' AND status='open' AND message LIKE 'Mac bridge offline%'`).get() as { n: number };
    expect(open.n).toBe(1);
  } finally {
    db.close();
  }
  await checkBridgeHealth(now + 10 * 60_000, fake, on);
  const db2 = openTestDb();
  try {
    const n = db2.prepare(`SELECT COUNT(*) AS n FROM issues WHERE source='bridge_health' AND status='open' AND message LIKE 'Mac bridge offline%'`).get() as { n: number };
    expect(n.n).toBe(0);
  } finally {
    db2.close();
  }
});
