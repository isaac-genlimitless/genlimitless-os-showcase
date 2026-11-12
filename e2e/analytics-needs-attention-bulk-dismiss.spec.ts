import { test, expect } from "@playwright/test";

test("analytics Needs attention panel supports bulk dismiss without mutating real data", async ({
  page,
}) => {
  // Intercept PATCH /api/issues so the test never actually mutates health-log data.
  const patchBodies: any[] = [];
  await page.route("**/api/issues", async (route) => {
    const request = route.request();
    if (request.method() === "PATCH") {
      patchBodies.push(request.postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/analytics");
  await expect(page.getByText("Connected email accounts", { exact: true })).toBeVisible({ timeout: 15_000 });

  const heading = page.getByText(/^Needs attention \(\d+\)$/);
  if ((await heading.count()) === 0) {
    // No open issues right now - nothing to bulk-dismiss.
    return;
  }
  await expect(heading).toBeVisible();

  const dismissSelected = page.getByRole("button", { name: /^Dismiss selected \(\d+\)$/ });
  await expect(dismissSelected).toBeDisabled();

  const rows = page.getByTestId("issue-row");
  const firstRow = rows.first();
  await firstRow.getByRole("checkbox").check();

  await expect(dismissSelected).toBeEnabled();
  await dismissSelected.click();

  await expect
    .poll(() => patchBodies.some((b) => Array.isArray(b?.ids)))
    .toBe(true);

  const dismissAll = page.getByRole("button", { name: "Dismiss all" });
  await dismissAll.click();

  await expect
    .poll(() => patchBodies.some((b) => b?.all === true))
    .toBe(true);
});
