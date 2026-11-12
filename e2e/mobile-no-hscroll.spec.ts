import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";

// Phones: nothing may scroll sideways. The real scroller is <main> (and the chat list), not the
// document, so we measure both. Never presses Send or triggers an agent; only GET /api/chat is mocked.

test.afterEach(() => cleanupFilesPages());

const VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
];
const ROUTES = [
  "/", "/files", "/communications?tab=inbox", "/communications?tab=email",
  "/analytics", "/tasks", "/calendar", "/meetings", "/activity", "/team",
  "/settings", "/job-engine", "/job-engine?view=jobs", "/job-engine?view=linkedin",
];

async function expectNoHScroll(page: import("@playwright/test").Page) {
  const m = await page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      docW: document.documentElement.scrollWidth,
      inner: window.innerWidth,
      mainScroll: main ? main.scrollWidth : 0,
      mainClient: main ? main.clientWidth : 0,
    };
  });
  expect(m.docW).toBeLessThanOrEqual(m.inner);
  expect(m.mainScroll).toBeLessThanOrEqual(m.mainClient);
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    for (const route of ROUTES) {
      test(`no sideways scroll on ${route}`, async ({ page }) => {
        await page.goto(route);
        await page.waitForLoadState("networkidle");
        await expectNoHScroll(page);
      });
    }

    test("long words, code and tables in chat bubbles stay inside the screen", async ({ page }) => {
      const content =
        "x".repeat(200) + " https://example.com/" + "a".repeat(150) +
        "\n\n```\n" + "y".repeat(200) + "\n```\n\n| a | b | c | d | e | f |\n|---|---|---|---|---|---|\n| " +
        "z".repeat(60) + " | 1 | 2 | 3 | 4 | 5 |";
      await page.route("**/api/chat", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        await route.fulfill({
          json: {
            messages: [
              { id: 1, role: "assistant", content },
              { id: 2, role: "user", content: "w".repeat(200) },
            ],
            threads: [],
            running: [],
          },
        });
      });
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      const list = page.getByTestId("chat-messages");
      await expect(list).toBeVisible({ timeout: 20_000 });
      const sizes = await list.evaluate((el) => ({ s: el.scrollWidth, c: el.clientWidth }));
      expect(sizes.s).toBeLessThanOrEqual(sizes.c);
      const rights = await list.evaluate((el) =>
        Array.from(el.querySelectorAll(".markdown-body")).map((b) => b.getBoundingClientRect().right),
      );
      for (const r of rights) expect(r).toBeLessThanOrEqual(vp.width);
      await expectNoHScroll(page);
    });
  });
}

test.describe("Files page on a 320px phone", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("the editor stays inside the screen", async ({ page, request }) => {
    const title = `E2E Mobile ${Date.now()}`;
    const { page: p } = await (await request.post("/api/files", { data: { title, body: "# Hello\n\nSome content." } })).json();
    await page.goto(`/files?id=${p.id}`);
    await expect(page.getByLabel("Title")).toHaveValue(title, { timeout: 20_000 });
    const box = await page.locator(".page-editor").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    await expectNoHScroll(page);
  });
});
