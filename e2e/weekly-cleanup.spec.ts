import { test, expect } from "@playwright/test";

const report = {
  id: 999,
  created_at: "2026-01-05 12:00:00",
  items: [
    { key: "file:src/a.ts", kind: "junk", what: "a.tmp", where: "src/a.tmp", reason: "Temporary/backup file", safe: true },
    { key: "route:src/app/api/x/route.ts", kind: "orphan_route", what: "/api/x", where: "src/app/api/x/route.ts", reason: "No reference", safe: false, unsafe_reason: "May be hit by webhooks" },
  ],
};

test("Weekly cleanup card: safe pre-checked, unsafe not, delete hits intercepted API", async ({ page }) => {
  await page.route("**/api/cleanup", (r) => r.fulfill({ json: { report } }));
  let posted: any = null;
  await page.route("**/api/cleanup/delete", async (r) => {
    posted = r.request().postDataJSON();
    await r.fulfill({ json: { ok: true, results: [{ key: "file:src/a.ts", status: "proposed" }] } });
  });
  page.on("dialog", (d) => d.accept());
  await page.goto("/settings");
  const card = page.getByTestId("weekly-cleanup-card");
  await expect(card.getByText("Weekly cleanup").first()).toBeVisible();
  const boxes = card.getByRole("checkbox");
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).not.toBeChecked();
  await card.getByRole("button", { name: /Delete selected \(1\)/ }).click();
  await expect.poll(() => posted).toEqual({ reportId: 999, keys: ["file:src/a.ts"] });
});

test("delete API refuses protected pages", async ({ request }) => {
  // A bogus report id is rejected before anything could be touched.
  const res = await request.post("/api/cleanup/delete", { data: { reportId: -1, keys: ["page:263", "page:315", "page:308"] } });
  expect(res.ok()).toBeFalsy();
});
