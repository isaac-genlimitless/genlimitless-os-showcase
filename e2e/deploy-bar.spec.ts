import { test, expect, type Page } from "@playwright/test";

// Never presses Send, never clicks Deploy, never triggers an agent. /api/deploy is mocked.

async function mockDeploy(page: Page, body: unknown) {
  const posts: string[] = [];
  await page.route("**/api/deploy", (route) => {
    if (route.request().method() === "POST") {
      posts.push("POST");
      return route.fulfill({ json: { error: "blocked in test" } });
    }
    return route.fulfill({ json: body });
  });
  return posts;
}

test("shows Deploy button when server is behind GitHub", async ({ page }) => {
  const posts = await mockDeploy(page, { enabled: true, live: "aaa", latest: "bbb", behind: true, status: null });
  await page.goto("/");
  await expect(page.getByTestId("deploy-bar").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Deploy to server" }).first()).toBeVisible();
  expect(posts.length).toBe(0);
});

test("hidden when server is up to date", async ({ page }) => {
  await mockDeploy(page, { enabled: true, live: "aaa", latest: "aaa", behind: false, status: { state: "idle", message: "" } });
  const resp = page.waitForResponse("**/api/deploy");
  await page.goto("/");
  await resp;
  await page.waitForTimeout(300);
  await expect(page.getByTestId("deploy-bar")).toHaveCount(0);
});

test("hidden when deploys are not enabled", async ({ page }) => {
  await mockDeploy(page, { enabled: false });
  const resp = page.waitForResponse("**/api/deploy");
  await page.goto("/");
  await resp;
  await page.waitForTimeout(300);
  await expect(page.getByTestId("deploy-bar")).toHaveCount(0);
});
