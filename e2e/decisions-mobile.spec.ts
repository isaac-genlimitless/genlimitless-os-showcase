import { test, expect, type Page } from "@playwright/test";
import db from "../src/lib/db";

// Phone-size checks for /decisions. Measure only: this file never clicks Send, Approve or anything else.
const isolated = !!process.env.E2E_START_SERVER;

async function load(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/decisions");
  await expect(page.getByTestId("decisions-list").or(page.getByTestId("decisions-empty"))).toBeVisible();
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("390px: no sideways scroll", async ({ page }) => {
  await load(page, 390, 844);
  expect(await overflow(page)).toBeLessThanOrEqual(1);
});

test("320px: no sideways scroll", async ({ page }) => {
  await load(page, 320, 640);
  expect(await overflow(page)).toBeLessThanOrEqual(1);
});

test("390px: buttons are thumb-sized and Send/Discard are apart", async ({ page }) => {
  await load(page, 390, 844);
  const targets = page.locator('[data-testid=decision-row] button, [data-testid=decision-row] a, [data-testid=autopilot-panel] button');
  const n = await targets.count();
  for (let k = 0; k < n; k++) {
    const el = targets.nth(k);
    if (!(await el.isVisible())) continue;
    const box = await el.boundingBox();
    expect(box!.height, `target ${k} height`).toBeGreaterThanOrEqual(40);
  }
  const rows = page.getByTestId("decision-row");
  for (let r = 0; r < (await rows.count()); r++) {
    const btns = rows.nth(r).locator("button:not([aria-label])");
    const boxes: { x: number; y: number; width: number; height: number }[] = [];
    for (let b = 0; b < (await btns.count()); b++) {
      const bb = await btns.nth(b).boundingBox();
      if (bb) boxes.push(bb);
    }
    for (let a = 0; a < boxes.length; a++)
      for (let c = a + 1; c < boxes.length; c++) {
        const A = boxes[a], B = boxes[c];
        const gapX = Math.max(B.x - (A.x + A.width), A.x - (B.x + B.width));
        const gapY = Math.max(B.y - (A.y + A.height), A.y - (B.y + B.height));
        expect(Math.max(gapX, gapY), "gap between row buttons").toBeGreaterThanOrEqual(8);
      }
  }
});

test("a 200-character title stays inside a phone screen (isolated server only)", async ({ page }) => {
  test.skip(!isolated, "writes data: only under `npm run test:e2e:branch`");
  const id = Number(
    db.prepare(`INSERT INTO schedule_items (date, title, start, end, status) VALUES ('2099-01-01', ?, '2099-01-01T09:00:00-06:00', '2099-01-01T10:00:00-06:00', 'proposed')`).run("X".repeat(200)).lastInsertRowid,
  );
  try {
    await load(page, 390, 844);
    await expect(page.getByTestId("decision-row").filter({ hasText: "XXXXXXXXXX" }).first()).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  } finally {
    db.prepare(`UPDATE schedule_items SET status='rejected' WHERE id=?`).run(id);
  }
});

test("desktop 1280px still shows the heading and the list", async ({ page }) => {
  await load(page, 1280, 800);
  await expect(page.getByRole("heading", { name: "Decisions", exact: true })).toBeVisible();
});
