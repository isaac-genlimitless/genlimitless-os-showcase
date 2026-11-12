import { test, expect } from "./isolated-test";

test("settings shows the read-only disk usage card", async ({ page }) => {
  await page.route("**/api/disk-usage*", (route) =>
    route.fulfill({
      json: {
        at: "2026-10-29T05:00:00Z", root: "/opt/genlimitless-os",
        runningRelease: "63179161463f", currentRelease: "63179161463f", previousRelease: "aaaaaaaaaaaa",
        folders: [
          { folder: "backups", path: "/opt/genlimitless-os/backups", exists: true, totalBytes: 8482560000, entryCount: 1, truncated: false,
            entries: [{ name: "pre-deploy-20261028T120000Z-63179161463f.db", type: "file", bytes: 300000000, modified: "2026-10-28T12:00:00Z", tags: ["newest pre-deploy backup"] }] },
          { folder: "work", path: "/opt/genlimitless-os/work", exists: false, totalBytes: null, entryCount: 0, truncated: false, entries: [] },
        ],
      },
    })
  );
  await page.goto("/settings");
  const card = page.getByTestId("disk-usage-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("disk-usage-releases")).toContainText("63179161463f");
  await expect(page.getByTestId("disk-usage-releases")).toContainText("aaaaaaaaaaaa");
  const backups = card.locator('[data-folder="backups"]');
  await expect(backups).toContainText("7.9 GB");
  await backups.locator("summary").click();
  await expect(backups.getByTestId("disk-usage-entry")).toContainText("newest pre-deploy backup");
  await expect(card.locator('[data-folder="work"]')).toContainText("not present");
  await expect(card.getByRole("button", { name: /delete|remove/i })).toHaveCount(0);
});
