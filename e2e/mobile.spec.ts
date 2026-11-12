import { test, expect } from "@playwright/test";

// Mobile layout checks (375x812). Never presses Send or triggers an agent; /api/calendar is mocked.

test.use({ viewport: { width: 375, height: 812 } });

async function openCalendar(page: import("@playwright/test").Page) {
  await page.route("**/api/calendar?**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ json: { connected: true, accounts: ["owner@example.com"], events: [] } });
  });
  await page.goto("/calendar");
  await expect(page.getByTestId("calendar-range")).toBeVisible({ timeout: 15_000 });
}

test("calendar: header controls are tap-sized and the page does not scroll sideways", async ({ page }) => {
  await openCalendar(page);
  for (const loc of [
    page.getByRole("button", { name: "Today", exact: true }),
    page.getByRole("button", { name: "Previous" }),
    page.getByRole("button", { name: "Next" }),
    page.getByRole("button", { name: "day", exact: true }),
    page.getByRole("button", { name: "week", exact: true }),
    page.getByRole("button", { name: "month", exact: true }),
    page.getByRole("button", { name: "+ Event" }),
  ]) {
    await expect(loc).toBeVisible();
    expect((await loc.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("calendar: week grid scrolls horizontally inside itself, not the page", async ({ page }) => {
  await openCalendar(page);
  await page.getByRole("button", { name: "week", exact: true }).click();
  const grid = page.getByTestId("calendar-grid-scroll");
  await expect(grid).toBeVisible();
  const dims = await grid.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(dims.sw).toBeGreaterThan(dims.cw);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("chat home and communications tabs fit 375px with tap-sized tab buttons", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await page.goto("/communications?tab=email");
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  for (const name of ["Messages", "Email"]) {
    const btn = page.getByRole("button", { name, exact: true });
    await expect(btn).toBeVisible();
    const box = (await btn.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  }
});

test("two-pane screens stack on phones: no sideways scroll, panes use the full width", async ({ page }) => {
  for (const url of ["/communications?tab=inbox", "/communications?tab=email", "/files", "/meetings", "/activity"]) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.documentElement.scrollWidth), url).toBeLessThanOrEqual(375);
  }
  // Activity: the run list stacks above the detail and spans the screen instead of a 384px side column.
  await page.goto("/activity");
  const list = page.getByTestId("run-list");
  await expect(list).toBeVisible();
  expect((await list.boundingBox())!.width).toBeGreaterThanOrEqual(340);
});

test("team page fits 375px with long strings and clears the chat dock", async ({ page }) => {
  const long = "x".repeat(120);
  const now = new Date().toISOString();
  const agent = (slug: string, name: string, kind: "core" | "custom") => ({
    slug,
    name,
    kind,
    reports_to: kind === "core" ? null : "chief_of_staff",
    objective: `Objective ${long}`,
    responsibilities: `Responsibilities ${long}`,
    instructions: `Instructions ${long}`,
    status: "active",
    created_by: "owner",
    retired_reason: null,
    tools: [long],
    learnings: [{ id: 1, lesson: `Lesson ${long}`, source: "owner", created_at: now }],
    raw_signals: 0,
  });
  // Only GET /api/agents is mocked; nothing here clicks Approve/Decline/Dismiss or triggers an agent.
  await page.route("**/api/agents", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      json: {
        agents: [agent("chief_of_staff", "Chief of Staff", "core"), agent("marketing_director", "Marketing Director", "custom")],
        approvals: [{ id: 1, requested_by: "marketing_director", action: "send_email", target_id: 5, title: `Approve ${long}`, reason: `Reason ${long}`, created_at: now }],
        escalations: [{ id: 2, from_agent: "marketing_director", severity: "important", kind: "blocked", title: `Escalation ${long}`, detail: `Detail ${long}`, created_at: now }],
        priorities: [{ id: 3, title: `Priority ${long}`, detail: long, rank: 1 }],
        activity: [{ id: 4, agent_slug: "chief_of_staff", trigger: "chat", summary: `Summary ${long}`, created_at: now }],
        changes: [{ id: 5, agent_slug: "marketing_director", changed_by: "owner", field: "objective", reason: long, created_at: now }],
        majorFixes: 0,
        emailDrafts: 0,
      },
    });
  });
  await page.goto("/team");
  await expect(page.getByTestId("agent-chief_of_staff")).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  const cards = page.locator('[data-testid^="agent-"], [data-testid="needs-approval"]');
  const n = await cards.count();
  expect(n).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < n; i++) {
    const box = (await cards.nth(i).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  }

  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeVisible();
  const ab = (await approve.boundingBox())!;
  expect(ab.x + ab.width).toBeLessThanOrEqual(375);

  await page.evaluate(() => document.querySelector("main")!.scrollTo(0, 1e6));
  const lastBottom = await page.evaluate(() => {
    const root = document.querySelector(".team-page")!;
    return (root.lastElementChild as HTMLElement).getBoundingClientRect().bottom;
  });
  const dock = (await page.getByTestId("chat-dock-open").boundingBox())!;
  expect(lastBottom).toBeLessThanOrEqual(dock.y);
});

test("calendar: day view shows a single wide column", async ({ page }) => {
  await openCalendar(page);
  await page.getByRole("button", { name: "day", exact: true }).click();
  const cols = page.locator("[data-day-col]");
  await expect(cols).toHaveCount(1);
  expect((await cols.first().boundingBox())!.width).toBeGreaterThan(250);
});
