import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";

// Remove icon control. Never presses Send or triggers an agent.

test.afterEach(() => cleanupFilesPages());

const unique = (label: string) => `E2E ${label} ${Date.now()}`;

test("Remove icon clears only the icon", async ({ page, request }) => {
  const title = unique("RemoveIcon");
  const { page: p } = await (await request.post("/api/files", { data: { title, body: "Keep this content.", icon: "🚀" } })).json();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/files?id=${p.id}`);
  await expect(page.locator(".bn-editor").getByText("Keep this content.")).toBeVisible({ timeout: 20_000 });

  const iconBtn = page.getByTitle("Change icon", { exact: true });
  await expect(iconBtn).toContainText("🚀");
  await iconBtn.click();
  await page.getByTestId("remove-icon").click();

  await expect
    .poll(async () => (await (await request.get(`/api/files/${p.id}`)).json()).page.icon, { timeout: 10_000 })
    .toBeNull();
  const saved = (await (await request.get(`/api/files/${p.id}`)).json()).page;
  expect(saved.title).toBe(title);
  expect(saved.body).toContain("Keep this content.");
  await expect(iconBtn).not.toContainText("🚀");
  await expect(page.getByTestId("remove-icon")).toHaveCount(0);
});

test("no icon: picker has no Remove icon", async ({ page, request }) => {
  const { page: p } = await (await request.post("/api/files", { data: { title: unique("NoIcon"), body: "Plain content." } })).json();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/files?id=${p.id}`);
  await expect(page.locator(".bn-editor").getByText("Plain content.")).toBeVisible({ timeout: 20_000 });
  await page.getByTitle("Change icon", { exact: true }).click();
  await expect(page.getByTestId("remove-icon")).toHaveCount(0);
});
