import { test, expect } from "./isolated-test";
import { isLinkedInSocialUrl, parseLinkedInPublic } from "../src/lib/web-page-social";

// Unit-level only, fixtures, no network. Never presses Send or triggers an agent.
for (const vp of [{ name: "mobile", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 800 }]) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("LinkedIn URL shapes and fixture parsing", () => {
      expect(isLinkedInSocialUrl(new URL("https://www.linkedin.com/in/jane-doe"))).toBe(true);
      expect(isLinkedInSocialUrl(new URL("https://www.linkedin.com/in/../admin"))).toBe(false);
      expect(isLinkedInSocialUrl(new URL("https://evil.com/in/jane"))).toBe(false);
      const html = `<meta property="og:title" content="Acme | LinkedIn"><script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>`;
      expect(parseLinkedInPublic(html)?.text).toContain("Name: Acme");
    });

    test("existing settings page still loads", async ({ page }) => {
      await page.goto("/settings");
      await expect(page.locator("body")).toBeVisible();
    });
  });
}
