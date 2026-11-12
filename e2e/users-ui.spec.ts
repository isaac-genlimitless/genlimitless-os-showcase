import { test, expect } from "./isolated-test";

// Read-only navigation and dialogs. The mutating cycle only runs on an isolated server. Never presses Send or triggers an agent.
const noSideScroll = async (page: import("@playwright/test").Page) => {
  const m = await page.evaluate(() => {
    const main = document.querySelector("main");
    return { docScroll: document.documentElement.scrollWidth, inner: window.innerWidth, mainScroll: main ? main.scrollWidth : 0, mainClient: main ? main.clientWidth : 0 };
  });
  expect(m.docScroll).toBeLessThanOrEqual(m.inner);
  expect(m.mainScroll).toBeLessThanOrEqual(m.mainClient);
};

test("settings still shows General content", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
});

test.describe("desktop table", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("users table has every column; no View as for admin", async ({ page }) => {
    await page.goto("/settings?tab=users");
    const table = page.getByTestId("users-table");
    await expect(table).toBeVisible();
    for (const h of ["Name", "Email", "Role", "Created", "Last active", "Status", "Actions"]) {
      await expect(table.getByRole("columnheader", { name: h })).toBeVisible();
    }
    const admin = table.locator('[data-testid="user-row"][data-role="admin"]');
    if (await admin.count()) await expect(admin.first().getByRole("button", { name: "View as" })).toHaveCount(0);
  });
});

for (const size of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
  test.describe(`users at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });
    test("no sideways scroll, cards show fields, 44px buttons", async ({ page }) => {
      await page.goto("/settings?tab=users");
      await page.waitForLoadState("networkidle");
      await noSideScroll(page);
      const cards = page.getByTestId("user-card");
      if (await cards.count()) {
        const first = cards.first();
        await expect(first).toContainText("Created:");
        await expect(first).toContainText("Last active:");
        await expect(first).toContainText(/Admin|Member/);
        await expect(first).toContainText(/Active|Deactivated|Removed/);
        for (const b of await first.getByRole("button").all()) {
          const box = await b.boundingBox();
          expect(box!.height).toBeGreaterThanOrEqual(43.5);
        }
        await expect(cards.locator(':scope[data-role="admin"]').first().getByRole("button", { name: "View as" })).toHaveCount(0);
      }
    });
  });
}

// Mocked /api/users*: asserts each button sends the right method/body. No real sends or agents.
for (const vp of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone 375px", width: 375, height: 812 }]) {
  test.describe(`users buttons match API (${vp.name})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    async function setup(page: import("@playwright/test").Page, users: unknown[], showRemoved = false) {
      const calls: { method: string; body: unknown }[] = [];
      await page.route("**/api/users**", async (route) => {
        const req = route.request();
        const path = new URL(req.url()).pathname;
        if (path === "/api/users" && req.method() === "GET") {
          return route.fulfill({ json: { users } });
        }
        if (/^\/api\/users\/[^/]+$/.test(path)) {
          calls.push({ method: req.method(), body: req.postDataJSON() });
          return route.fulfill({ json: { ok: true } });
        }
        return route.continue();
      });
      await page.goto("/settings?tab=users");
      if (showRemoved) await page.getByLabel(/Show removed/).check();
      const scope = page.getByTestId(vp.width >= 768 ? "user-row" : "user-card").first();
      await expect(scope).toBeVisible();
      return { calls, scope };
    }
    const member = { id: "u1", name: "Pat Member", email: "pat@example.invalid", phone: null, role: "member" };

    test("deactivate and remove send POST {action}", async ({ page }) => {
      const { calls, scope } = await setup(page, [member]);
      await scope.getByRole("button", { name: "Deactivate" }).click();
      await expect.poll(() => calls.length).toBe(1);
      expect(calls[0]).toEqual({ method: "POST", body: { action: "deactivate" } });
      await scope.getByRole("button", { name: "Remove" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
      await expect.poll(() => calls.length).toBe(2);
      expect(calls[1]).toEqual({ method: "POST", body: { action: "remove" } });
    });

    test("reactivate sends POST {action}", async ({ page }) => {
      const { calls, scope } = await setup(page, [{ ...member, disabled: true }]);
      await scope.getByRole("button", { name: "Reactivate" }).click();
      await expect.poll(() => calls.length).toBe(1);
      expect(calls[0]).toEqual({ method: "POST", body: { action: "reactivate" } });
    });

    test("restore sends POST {action:restore}", async ({ page }) => {
      const { calls, scope } = await setup(page, [{ ...member, removed: true }], true);
      await scope.getByRole("button", { name: "Restore" }).click();
      await expect.poll(() => calls.length).toBe(1);
      expect(calls[0]).toEqual({ method: "POST", body: { action: "restore" } });
    });

    test("edit sends PATCH display_name, then PATCH role owner alone", async ({ page }) => {
      const { calls, scope } = await setup(page, [member]);
      await scope.getByRole("button", { name: "Edit" }).click();
      const dlg = page.getByRole("dialog");
      await dlg.getByLabel("Name").fill("Pat Renamed");
      await dlg.getByLabel("Role").selectOption("admin");
      await dlg.getByRole("button", { name: "Save" }).click();
      await expect.poll(() => calls.length).toBe(2);
      expect(calls[0]).toEqual({ method: "PATCH", body: { display_name: "Pat Renamed", email: "pat@example.invalid", phone: null } });
      expect(calls[1]).toEqual({ method: "PATCH", body: { role: "owner" } });
    });
  });
}

test.describe("impersonation cycle (isolated server only)", () => {
  test.skip(!process.env.E2E_START_SERVER, "mutating: only on an isolated server");
  test.use({ viewport: { width: 390, height: 844 } });

  test("view as member, read-only, exit", async ({ page }) => {
    await page.goto("/settings?tab=users");
    const member = page.getByTestId("user-card").and(page.locator('[data-role="member"]')).first();
    await expect(member).toBeVisible();
    const name = (await member.locator("div").first().innerText()).trim();
    await member.getByRole("button", { name: "View as" }).click();
    await page.waitForURL("**/");
    const banner = page.getByTestId("impersonation-banner");
    await expect(banner).toContainText(`Viewing as ${name}`);
    await expect(page.getByTestId("impersonation-countdown")).toHaveText(/\d+:\d\d/);
    const exit = banner.getByRole("button", { name: "Exit" });
    expect((await exit.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);

    const res = await page.request.post("/api/users", { data: { name: "x", email: "x@example.invalid" } });
    expect(res.status()).toBe(403);

    await exit.click();
    await page.waitForURL("**/");
    await expect(page.getByTestId("impersonation-banner")).toHaveCount(0);
  });

  test("countdown reaching 0 auto-exits", async ({ page }) => {
    await page.goto("/settings?tab=users");
    const member = page.getByTestId("user-card").and(page.locator('[data-role="member"]')).first();
    await member.getByRole("button", { name: "View as" }).click();
    await page.waitForURL("**/");
    await expect(page.getByTestId("impersonation-banner")).toBeVisible();
    await page.clock.install();
    await page.clock.fastForward("31:00");
    await expect(page.getByTestId("impersonation-banner")).toHaveCount(0, { timeout: 10000 });
  });
});

test.describe("users display uses the API's real field names", () => {
  const rows = { users: [
    { id: "owner", display_name: "Owner", email: null, phone: null, role: "owner", roleLabel: "Admin", status: "active", created_at: 1794262854525, last_active: 1794496862199, removed_at: null },
    { id: "test", display_name: "Test User", email: "owner@example.com", phone: null, role: "member", roleLabel: "Member", status: "active", created_at: 1794264539790, last_active: null, removed_at: null },
  ] };
  for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test(`names and dates render at ${size.width}px`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.route("**/api/users?removed=1", (r) => r.fulfill({ json: rows }));
      await page.goto("/settings?tab=users");
      const scope = size.width >= 768 ? page.getByTestId("user-row") : page.getByTestId("user-card");
      await expect(scope.first()).toContainText("Owner");
      await expect(scope.first()).toContainText("Admin");
      await expect(scope.first()).not.toContainText("Never");
      await expect(scope.nth(1)).toContainText("Test User");
      await expect(scope.nth(1)).toContainText("Member");
      await expect(scope.nth(1)).toContainText("Never");
      await expect(scope.first().getByRole("button", { name: "View as" })).toHaveCount(0);
      await noSideScroll(page);
    });
  }
});
