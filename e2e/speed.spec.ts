import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

// Speed sweep (2026-11-05): the OS was slow to open (blank for up to a minute), buttons stalled, and
// pages got slower as data grew. These guard the fixes. Read-only: nothing here sends or runs an agent.

const root = path.join(__dirname, "..");

test("nginx serves page JavaScript from disk without the login round-trip", () => {
  const conf = fs.readFileSync(path.join(root, "bridge/nginx-os-genlimitless.conf"), "utf8");
  const block = conf.match(/location \^~ \/_next\/static\/ \{([^}]*)\}/);
  expect(block, "/_next/static/ location in bridge/nginx-os-genlimitless.conf").toBeTruthy();
  expect(block![1]).toContain("auth_request off;");
  expect(block![1]).toContain("immutable");
  // Must point at the folder glos-deploy swaps live releases into (src/lib/deploy.ts ROOT + /current).
  expect(block![1]).toContain("alias /opt/genlimitless-os/current/.next/static/;");
  expect(fs.readFileSync(path.join(root, "src/lib/deploy.ts"), "utf8")).toContain('"/opt/genlimitless-os"');
});

test("hot scheduler queries use an index instead of reading the whole table", async () => {
  const dbMod = (await import("../src/lib/db")) as unknown as { default: { default?: unknown } };
  const db = (dbMod.default.default ?? dbMod.default) as import("better-sqlite3").Database;
  const { ensureIndexes, missingIndexes, INDEXES } = await import("../src/lib/db-indexes");
  ensureIndexes();
  expect(missingIndexes()).toEqual([]); // idempotent: nothing left to create once the tables exist
  expect(new Set(INDEXES.map((i) => i.name)).size).toBe(INDEXES.length);
  const plan = (sql: string, n: number) =>
    (db.prepare("EXPLAIN QUERY PLAN " + sql).all(...new Array(n).fill(1)) as { detail: string }[]).map((r) => r.detail).join(" | ");
  // logIssue / issue-once run on every error, many times a minute.
  expect(plan(`SELECT id, detail FROM issues WHERE source=? AND message=? AND status='open' LIMIT 1`, 2)).toContain("USING INDEX");
  // Delivery checks every minute.
  expect(plan(`SELECT * FROM imessage_sends WHERE status='pending' AND purpose != 'login_code' AND last_attempt_at < ?`, 1)).toContain("USING INDEX");
  expect(plan(`SELECT * FROM text_drafts WHERE status='pending_approval' ORDER BY id DESC LIMIT 100`, 0)).toContain("USING INDEX");
  expect(plan(`SELECT COUNT(*) as c FROM inbound_emails WHERE school_id = ?`, 1)).toContain("USING COVERING INDEX");
});

test("chat refresh looks up undo state only for the messages on screen", () => {
  // Runs on every chat poll (every 4-15s). It used to total every chat turn ever with a GROUP BY over
  // the whole history; now it only looks up the returned messages (chat_id is the primary key).
  const route = fs.readFileSync(path.join(root, "src/app/api/chat/route.ts"), "utf8");
  expect(route).toMatch(/WHERE t\.chat_id IN \(/);
});

test("pages don't wait on Google Fonts before drawing", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (r) => { if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) external.push(r.url()); });
  await page.goto("/login");
  await expect(page.locator('link[href*="fonts.googleapis.com"]')).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/Montserrat/i);
  expect(external).toEqual([]);
});
