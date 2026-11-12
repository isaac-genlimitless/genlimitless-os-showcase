import { test, expect } from "@playwright/test";

test("Farmhouse upload endpoint rejects bad requests (writes nothing)", async ({ page, request }) => {
  await page.goto("/the-creation?tab=farmhouse");
  const input = page.getByTestId("farmhouse-upload-input");
  await expect(input).toBeAttached();
  expect(await input.getAttribute("accept")).toContain(".html");

  const html = Buffer.from("<html><body>x</body></html>");
  const r1 = await request.post("/api/farmhouse/upload", {
    multipart: { variant: "bogus", file: { name: "x.html", mimeType: "text/html", buffer: html } },
  });
  expect(r1.status()).toBe(400);
  const r2 = await request.post("/api/farmhouse/upload", {
    multipart: { variant: "refined", file: { name: "x.txt", mimeType: "text/plain", buffer: html } },
  });
  expect(r2.status()).toBe(400);
});

// Read-only: never types into the editor, never presses Send or triggers an agent.
test("The Creation tab shows the four Files pages as sub-tabs (after the Creations home tab)", async ({ page }) => {
  await page.goto("/");
  const link = page.getByRole("link", { name: "The Creation" }).first();
  await expect(link).toBeVisible();
  const filesLoaded = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/files");
  await link.click();
  await expect(page).toHaveURL(/\/the-creation/);
  await filesLoaded;

  // Only the Files-page tabs: not the Creations home, Farmhouse or Dreamhouse tabs.
  const tabs = page.getByTestId("creation-tabs").getByRole("tab")
    .and(page.locator(":not([data-testid='creation-tab-farmhouse']):not([data-testid='creation-tab-dreamhouse']):not([data-testid='creation-tab-studio'])"));
  await expect(page.getByTestId("creation-tab-studio")).toHaveAttribute("aria-selected", "true"); // home is the default
  test.skip((await tabs.count()) === 0, "The Creation folder is absent in the test DB");

  const titles = ["Our New Card Game", "Scripture Study", "The Creation System", "Our Ideal Home"];
  for (const t of titles) {
    await expect(page.getByTestId("creation-tabs")).toContainText(t);
  }

  const second = tabs.nth(1);
  const testId = await second.getAttribute("data-testid");
  const id = testId!.replace("creation-tab-", "");
  await second.click();
  await expect(page).toHaveURL(new RegExp(`\\?tab=${id}`));
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(titles[1]);
  await expect(page.locator(".ProseMirror").first()).toBeVisible();
});

test("The Creation Farmhouse tab embeds the sandboxed 3D model", async ({ page, request }) => {
  await page.goto("/the-creation?tab=farmhouse");
  await expect(page.getByTestId("creation-tab-farmhouse")).toHaveAttribute("aria-selected", "true");
  const frame = page.getByTestId("farmhouse-frame");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("src", "/api/farmhouse/refined");
  const full = page.getByTestId("farmhouse-fullscreen");
  await expect(full).toHaveAttribute("href", "/api/farmhouse/refined");
  await expect(full).toHaveAttribute("target", "_blank");
  await expect(page.getByTestId("farmhouse-upload-input")).toBeAttached();
  await page.getByTestId("farmhouse-variant").selectOption("original");
  await expect(page.getByTestId("farmhouse-upload-input")).toBeAttached();
  const res = await request.get("/api/farmhouse/bogus");
  expect(res.status()).toBe(404);
});
