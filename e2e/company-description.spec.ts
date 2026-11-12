import { test, expect } from "@playwright/test";

// Company Description under the funding stage on /job-engine. API routes mocked. Never presses Send, never triggers an agent.

const mk = (id: string, company: string) => ({
  application_id: id, company, role: "Tester", status: "sent_to_review", note: null, posting_closed: false,
  favorite: false, updated_at: "2026-01-01T00:00:00Z",
  draft: { application_id: id, company, role: "Tester", job_url: "https://example.com/job", location: null, pay: null,
    fit_score: 80, status: "sent_to_review", files: [], created_at: "2026-01-01T00:00:00Z", resume: "r", cover_letter: "c" },
});

const LONG = "Acme builds developer tools for teams shipping software quickly. " + "verylongwordwithoutspaces".repeat(8) + " More text here to force wrapping on a phone screen.";

for (const vp of [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile 375", width: 375, height: 700 }]) {
  test(`description shows under the stage and wraps with no horizontal scroll (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.route("**/api/job-engine/applications", (route) =>
      route.fulfill({ json: { applications: [mk("a-1", "Acme Co"), mk("a-2", "Mystery Co")] } }));
    await page.route("**/api/job-engine/company-stages", (route) =>
      route.fulfill({
        json: {
          companies: [], map: { "acme co": "Series B" }, unknown: ["Mystery Co"],
          descriptions: { "acme co": { description: LONG, source: "https://example.com/acme" } },
        },
      }));
    await page.goto("/job-engine");
    const acme = page.getByTestId("je-row").filter({ hasText: "Acme Co" });
    await expect(acme.getByTestId("je-stage")).toHaveText(/Series B/);
    const desc = acme.getByTestId("je-company-description");
    await expect(desc).toContainText("Description:");
    await expect(desc).toContainText("Acme builds developer tools");
    const sBox = await acme.getByTestId("je-stage").boundingBox();
    const dBox = await desc.boundingBox();
    expect(dBox!.y).toBeGreaterThanOrEqual(sBox!.y + sBox!.height - 1);
    await expect(page.getByTestId("je-row").filter({ hasText: "Mystery Co" }).getByTestId("je-company-description")).toHaveCount(0);
    const noScroll = await page.evaluate(() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth);
    expect(noScroll).toBe(true);
  });
}
