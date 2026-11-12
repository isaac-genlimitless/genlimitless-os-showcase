import { test, expect } from "@playwright/test";
import db from "../src/lib/db";

// Never presses Send. Writes data only under the isolated server (`npm run test:e2e:branch`).
const isolated = !!process.env.E2E_START_SERVER;

test("GET /api/decisions/retired returns an items array", async ({ request }) => {
  const r = await request.get("/api/decisions/retired");
  expect(r.ok()).toBeTruthy();
  expect(Array.isArray((await r.json()).items)).toBe(true);
});

test("POST restore with a bad kind returns 400", async ({ request }) => {
  const r = await request.post("/api/decisions/retired", { data: { kind: "nope", id: 1 } });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toBeTruthy();
});

for (const [name, w, h] of [["phone", 390, 844], ["desktop", 1280, 800]] as const) {
  test(`retired panel + Put back works at ${name} (isolated server only)`, async ({ page }) => {
    test.skip(!isolated, "writes data: only under `npm run test:e2e:branch`");
    const tag = `e2eRetired${name}${Date.now()}`;
    const textId = Number(db.prepare(`INSERT INTO text_drafts (to_handle, contact_name, text, reason, status) VALUES ('+18015550${w}', ?, 'hello', 'r [Superseded: test]', 'superseded')`).run(tag).lastInsertRowid);
    // A block that ended earlier today: shows up as retired (and is refused on restore, so it stays put).
    const endedAt = new Date(Date.now() - 60_000);
    const calId = Number(
      db.prepare(`INSERT INTO schedule_items (date, title, start, end, status) VALUES (?, ?, ?, ?, 'expired')`).run(endedAt.toISOString().slice(0, 10), `${tag}-block`, new Date(Date.now() - 3600_000).toISOString(), endedAt.toISOString()).lastInsertRowid,
    );
    try {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/decisions");
      const panel = page.getByTestId("retired-panel");
      await expect(panel).toBeVisible();
      await panel.locator("summary").click();
      const textRow = page.getByTestId("retired-row").filter({ hasText: tag }).first();
      await expect(textRow).toBeVisible();
      await expect(page.getByTestId("retired-row").filter({ hasText: `${tag}-block` })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      const btn = textRow.getByTestId("retired-restore");
      if (w < 768) expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(43);
      await btn.click();
      const row = page.getByTestId("decisions-list").getByTestId("decision-row").filter({ hasText: tag });
      await expect(row).toBeVisible();
      await expect(row.getByRole("button", { name: "Send", exact: true })).toBeVisible(); // present, never clicked
    } finally {
      db.prepare(`UPDATE text_drafts SET status='cancelled' WHERE id=?`).run(textId);
      db.prepare(`UPDATE schedule_items SET status='rejected' WHERE id=?`).run(calId);
    }
  });
}
