import { test, expect } from "@playwright/test";
import { statusFor, alertDue, pctOf, worstOf } from "../src/lib/server-health-core";

test("server health core logic", () => {
  expect(statusFor(75)).toBe("green");
  expect(statusFor(75.1)).toBe("yellow");
  expect(statusFor(90)).toBe("yellow");
  expect(statusFor(90.1)).toBe("red");
  const now = Date.now();
  const h = 60 * 60 * 1000;
  expect(alertDue(null, now)).toBe(true);
  expect(alertDue(now - 11 * h, now)).toBe(false);
  expect(alertDue(now - 12 * h, now)).toBe(true);
  expect(pctOf(0, 0)).toBe(0);
  expect(worstOf(["green", "red", "yellow"])).toBe("red");
});

test("settings shows server health card (mocked)", async ({ page }) => {
  const GB = 1024 ** 3;
  await page.route("**/api/server-health", (route) =>
    route.fulfill({
      json: {
        at: new Date().toISOString(),
        overall: "red",
        memory: { total: 10 * GB, used: 9.5 * GB, free: 0.5 * GB, pct: 95, status: "red" },
        disk: { total: 100 * GB, used: 80 * GB, free: 20 * GB, pct: 80, status: "yellow" },
        cpu: { load1: 0.1, load5: 0.2, load15: 0.3, cores: 1, pct: 10, status: "green" },
        uptime: { serverSeconds: 90000, processSeconds: 3600 },
        nodeProcess: { pid: 1, rss: GB, heapUsed: GB / 2, heapTotal: GB, external: 0, rssPctOfRam: 10 },
        sizes: {
          osRoot: 5 * GB,
          releases: 3 * GB,
          data: 1 * GB,
          topFolders: [
            { path: "/opt/genlimitless-os/releases/aaa", bytes: 2 * GB },
            { path: "/opt/genlimitless-os/data", bytes: GB },
          ],
        },
        hints: ["5 older releases use 2.0 GB. Old releases are removed automatically."],
        releaseCleanup: {
          last: {
            at: new Date().toISOString(),
            trigger: "health-check",
            kept: ["aaaaaaaaaaaa"],
            removed: [
              { name: "bbbbbbbbbbbb", bytes: 1 * GB },
              { name: "cccccccccccc", bytes: 0.5 * GB },
            ],
            failed: [],
            freedBytes: 1.5 * GB,
          },
          history: [],
          totalFreedBytes: 1.5 * GB,
        },
        thresholds: { yellowAbove: 75, redAbove: 90 },
      },
    })
  );
  await page.goto("/settings");
  const card = page.getByTestId("server-health-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("health-memory")).toHaveAttribute("data-status", "red");
  await expect(page.getByTestId("health-disk")).toHaveAttribute("data-status", "yellow");
  await expect(page.getByTestId("health-cpu")).toHaveAttribute("data-status", "green");
  await expect(page.getByTestId("server-health-overall")).toHaveAttribute("data-status", "red");
  const list = page.getByTestId("health-top-folders");
  await expect(list).toContainText("/opt/genlimitless-os/releases/aaa");
  await expect(list).toContainText("/opt/genlimitless-os/data");
  await expect(page.getByTestId("release-cleanup")).toBeVisible();
  await expect(page.getByTestId("release-cleanup-freed")).toContainText("Freed 1.5 GB");
  await expect(card.getByText("Only release folders are ever removed").first()).toBeVisible();
  expect((await card.innerText()).toLowerCase()).not.toContain("bridge");
});

test("live server health API shape", async ({ request }) => {
  const r = await request.get("/api/server-health");
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.memory.total).toBeGreaterThan(0);
  expect(j.disk.total).toBeGreaterThan(0);
  expect(j.cpu.cores).toBeGreaterThanOrEqual(1);
  expect(j.uptime.serverSeconds).toBeGreaterThan(0);
  expect(j.nodeProcess.rss).toBeGreaterThan(0);
  expect(j.thresholds).toEqual({ yellowAbove: 75, redAbove: 90 });
});
