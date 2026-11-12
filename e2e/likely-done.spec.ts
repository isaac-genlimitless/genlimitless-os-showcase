import { test, expect, type Page } from "@playwright/test";

// All /api/task-evidence* calls are mocked, so this is safe on live and in the branch run.
// Never presses Send and never triggers an agent.

const flagged = () => [
  { id: 9001, title: "Mock task one", source: "text_sent", person: "Sam", date: "Nov 3", excerpt: "I sent the form in today. ".repeat(20), reasoning: "You said it was sent." },
  { id: 9002, title: "Mock task two", source: "email_received", person: "Dana", date: "Nov 4", excerpt: "Confirmed.", reasoning: "They confirmed." },
];
const closedList = () => [{ id: 9003, title: "Mock auto closed", source: "calendar", person: "", date: "Nov 5", excerpt: "Meeting held", reasoning: "Event passed." }];

async function mock(page: Page, opts: { likely?: any[]; closed?: any[]; status?: number } = {}) {
  const posts: any[] = [];
  let likely = opts.likely ?? flagged();
  const closed = opts.closed ?? closedList();
  await page.route("**/api/task-evidence**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "POST") {
      posts.push(req.postDataJSON());
      const status = opts.status ?? 200;
      if (status === 200) {
        const id = Number(url.pathname.split("/").pop());
        likely = likely.filter((x) => x.id !== id);
      }
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ ok: status === 200 }) });
    }
    const view = url.searchParams.get("view");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: view === "auto_closed" ? closed : likely }) });
  });
  return posts;
}

test.describe("Likely done on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("cards fit 390px with 44px buttons", async ({ page }) => {
    await mock(page);
    await page.goto("/tasks");
    await expect(page.getByTestId("likely-done")).toBeVisible();
    await expect(page.getByTestId("likely-done-card")).toHaveCount(2);
    await page.waitForLoadState("networkidle");
    const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    expect(m.s).toBeLessThanOrEqual(m.c);
    for (const id of ["likely-done-yes", "likely-done-no"]) {
      const btns = page.getByTestId(id);
      for (let i = 0; i < (await btns.count()); i++) {
        const b = await btns.nth(i).boundingBox();
        expect(b!.height).toBeGreaterThanOrEqual(44);
        expect(b!.x).toBeGreaterThanOrEqual(0);
        expect(b!.x + b!.width).toBeLessThanOrEqual(390);
      }
    }
  });

  test("Done posts done and removes the card", async ({ page }) => {
    const posts = await mock(page);
    await page.goto("/tasks");
    await expect(page.getByTestId("likely-done-card")).toHaveCount(2);
    await page.getByTestId("likely-done-card").first().getByTestId("likely-done-yes").click();
    await expect(page.getByTestId("likely-done-card")).toHaveCount(1);
    await expect(page.getByTestId("likely-done")).toContainText("(1)");
    expect(posts[0]).toEqual({ action: "done" });
  });

  test("Not yet posts not_yet", async ({ page }) => {
    const posts = await mock(page);
    await page.goto("/tasks");
    await page.getByTestId("likely-done-card").first().getByTestId("likely-done-no").click();
    await expect(page.getByTestId("likely-done-card")).toHaveCount(1);
    expect(posts[0]).toEqual({ action: "not_yet" });
  });

  test("a failed request shows an error and keeps the card", async ({ page }) => {
    await mock(page, { status: 500 });
    await page.goto("/tasks");
    await page.getByTestId("likely-done-card").first().getByTestId("likely-done-yes").click();
    await expect(page.getByText("Couldn't save that")).toBeVisible();
    await expect(page.getByTestId("likely-done-card")).toHaveCount(2);
  });

  test("Undo on an auto-closed task posts revert", async ({ page }) => {
    const posts = await mock(page);
    await page.goto("/tasks");
    await page.getByText("Auto-closed by the OS in the last 7 days").click();
    await page.getByTestId("auto-closed-undo").click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toEqual({ action: "revert" });
  });

  test("empty response renders nothing", async ({ page }) => {
    await mock(page, { likely: [], closed: [] });
    await page.goto("/tasks");
    await expect(page.getByTestId("task-add")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("likely-done")).toHaveCount(0);
    await expect(page.getByTestId("likely-done-wrap")).toHaveCount(0);
  });
});

test.describe("Likely done on desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("renders", async ({ page }) => {
    await mock(page);
    await page.goto("/tasks");
    await expect(page.getByTestId("likely-done")).toBeVisible();
    await expect(page.getByTestId("likely-done-card")).toHaveCount(2);
  });
});
