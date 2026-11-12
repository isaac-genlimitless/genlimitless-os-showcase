import { test, expect } from "@playwright/test";

// Read-only: the OS follows the Mac's appearance (light by day, dark at night on Auto).

const bodyBg = (page: import("@playwright/test").Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test("light system appearance gives the light palette, dark gives the dark one, switching live", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/team");
  await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible({ timeout: 15_000 });
  expect(await bodyBg(page)).toBe("rgb(10, 10, 10)");

  await page.emulateMedia({ colorScheme: "light" }); // no reload: follows the switch live
  expect(await bodyBg(page)).toBe("rgb(246, 245, 241)");
  const panel = await page.getByTestId("agent-chief_of_staff").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(panel).toBe("rgb(255, 255, 255)");
});
