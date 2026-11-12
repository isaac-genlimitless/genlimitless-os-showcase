import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";

// Files home cards at a narrow width. Never presses Send or triggers an agent.

test.afterEach(() => cleanupFilesPages());

test("Files home cards stay readable at ~950px: small icon, wide cards, title not squished", async ({ page, request }) => {
  const stamp = Date.now();
  const folderTitle = `E2E Projects Folder ${stamp}`;
  const pageTitle = `E2E Code Audit Notes ${stamp}`;
  await request.post("/api/files", { data: { title: folderTitle, kind: "folder" } });
  await request.post("/api/files", { data: { title: pageTitle, body: "narrow card test" } });
  await page.setViewportSize({ width: 950, height: 800 });
  await page.goto("/files");
  for (const [tid, title] of [["files-home-folder-card", folderTitle], ["files-home-recent-card", pageTitle]] as const) {
    const card = page.getByTestId(tid).filter({ hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    const box = await card.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(170);
    const tbox = await card.locator("span.line-clamp-2").first().boundingBox();
    expect(tbox!.width).toBeGreaterThanOrEqual(100);
    const icon = card.locator("span.shrink-0").first();
    expect(await icon.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(18);
    const ibox = await icon.boundingBox();
    expect(ibox!.y - box!.y).toBeLessThan(20);
  }
  await page.screenshot({ path: "test-results/files-home-narrow-950.png" });
});
