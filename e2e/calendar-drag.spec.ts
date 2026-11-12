import { test, expect, type Page, type Locator } from "@playwright/test";

// Drag-to-move on the Calendar tab. Never touches the real calendar: both /api/calendar (GET) and
// /api/calendar/move (POST) are mocked. Never presses Send or triggers an agent.

test.use({ timezoneId: "UTC" });

const today = new Date().toISOString().slice(0, 10);
const at = (h: number) => `${today}T${String(h).padStart(2, "0")}:00:00.000Z`;

type Ev = { id: string; account: string; summary: string; description: string; start: string; end: string; attendees: string[]; status: string; htmlLink: string };
const baseEvents = (): Ev[] => [
  { id: "solo1", account: "owner@example.com", summary: "Solo focus", description: "", start: at(10), end: at(11), attendees: [], status: "confirmed", htmlLink: "" },
  { id: "guest1", account: "owner@example.com", summary: "Guest call", description: "", start: at(14), end: at(15), attendees: ["pat@outside.example"], status: "confirmed", htmlLink: "" },
];

async function setup(page: Page, move: { status: number; body: any }) {
  let events = baseEvents();
  const posts: any[] = [];
  await page.route("**/api/calendar?**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ json: { connected: true, accounts: ["owner@example.com"], events } });
  });
  await page.route("**/api/calendar/move", (route) => {
    const body = route.request().postDataJSON();
    posts.push(body);
    if (move.status === 200) {
      events = events.map((e) => (e.id === body.id ? { ...e, start: body.start, end: body.end } : e));
      return route.fulfill({ status: 200, json: { event: events.find((e) => e.id === body.id) } });
    }
    return route.fulfill({ status: move.status, json: move.body });
  });
  await page.goto("/calendar");
  await page.getByRole("button", { name: "day", exact: true }).click();
  return posts;
}

async function dragBy(page: Page, loc: Locator, dy: number) {
  const b = (await loc.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + 12; // well clear of the resize handle at the bottom edge
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy / 2, { steps: 5 });
  await page.mouse.move(x, y + dy, { steps: 5 });
  await page.mouse.up();
}

const top = async (loc: Locator) => (await loc.boundingBox())!.y;

test("dragging a solo event down 2h moves it, keeping its duration", async ({ page }) => {
  const posts = await setup(page, { status: 200, body: {} });
  const ev = page.locator('[data-event-id="solo1"]');
  await expect(ev).toBeVisible({ timeout: 15_000 });
  const before = await top(ev);
  await dragBy(page, ev, 96);
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].id).toBe("solo1");
  expect(posts[0].start).toBe(at(12));
  expect(Date.parse(posts[0].end) - Date.parse(posts[0].start)).toBe(3600e3);
  await expect.poll(() => top(ev)).toBeCloseTo(before + 96, 0);
  await expect(page.getByTestId("event-panel")).toHaveCount(0);
});

test("drags snap to 15 minutes", async ({ page }) => {
  const posts = await setup(page, { status: 200, body: {} });
  const ev = page.locator('[data-event-id="solo1"]');
  await expect(ev).toBeVisible({ timeout: 15_000 });
  await dragBy(page, ev, 20); // 25 minutes of grid, snaps to 30
  await expect.poll(() => posts.length).toBe(1);
  const s = new Date(posts[0].start);
  expect(s.getUTCMinutes() % 15).toBe(0);
  expect(posts[0].start).toBe(`${today}T10:30:00.000Z`);
  expect(Date.parse(posts[0].end) - Date.parse(posts[0].start)).toBe(3600e3);
});

test("an event with outside guests snaps back and shows the approval toast", async ({ page }) => {
  const posts = await setup(page, { status: 202, body: { approval: true, request_id: 1 } });
  const ev = page.locator('[data-event-id="guest1"]');
  await expect(ev).toBeVisible({ timeout: 15_000 });
  const before = await top(ev);
  await dragBy(page, ev, 48);
  await expect.poll(() => posts.length).toBe(1);
  await expect(page.getByTestId("calendar-toast")).toContainText("Sent for your approval");
  await expect.poll(() => top(ev)).toBeCloseTo(before, 0);
});

test("a failed move rolls back and shows a red toast", async ({ page }) => {
  const posts = await setup(page, { status: 500, body: { error: "boom" } });
  const ev = page.locator('[data-event-id="solo1"]');
  await expect(ev).toBeVisible({ timeout: 15_000 });
  const before = await top(ev);
  await dragBy(page, ev, 96);
  await expect.poll(() => posts.length).toBe(1);
  const toast = page.getByTestId("calendar-toast");
  await expect(toast).toContainText("boom");
  await expect(toast).toHaveAttribute("data-kind", "error");
  await expect.poll(() => top(ev)).toBeCloseTo(before, 0);
});
