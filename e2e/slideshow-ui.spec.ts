import { test, expect } from "./isolated-test";

// Never presses Send or triggers an agent. Runs only against the isolated server.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

async function seedFile(request: import("@playwright/test").APIRequestContext) {
  const id = (await (await request.post("/api/files", { data: { title: "Family photos" } })).json()).page.id as number;
  const api = `/api/slideshows/file-${id}`;
  const { photo } = await (await request.post(`${api}/photos`, { multipart: { file: { name: "a.png", mimeType: "image/png", buffer: PNG } } })).json();
  const put = await request.put(api, { data: { title: "Trip", slides: [{ id: "p1", type: "photo", photo }, { id: "q1", type: "quote", text: "QuoteText", name: "Mom" }] } });
  expect(put.ok()).toBeTruthy();
  return { id, api, photo: photo as string };
}

test("player: autoplay, counter, contained photo, buttons and arrow keys on a phone", async ({ page, request }) => {
  const { api, photo } = await seedFile(request);
  const img = await request.get(`${api}/photos/${photo}`);
  expect(img.status()).toBe(200);
  expect(img.headers()["content-type"]).toBe("image/png");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${api}/play`);
  const count = page.locator("#count");
  await expect(count).toHaveText("1 / 2");
  await expect(page.locator("img.photo")).toHaveCSS("object-fit", "contain");
  await expect(count).toHaveText("2 / 2", { timeout: 6000 }); // auto-advanced after 3s
  await expect(page.getByText("QuoteText")).toBeVisible();
  await expect(page.getByText("Mom")).toBeVisible();
  await expect(page.getByRole("button", { name: "Replay" })).toBeVisible({ timeout: 6000 });
  await page.keyboard.press("ArrowLeft");
  await expect(count).toHaveText("1 / 2");
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  await page.getByRole("button", { name: "Next slide" }).click();
  await expect(count).toHaveText("2 / 2");
});

test("generic /slideshow page uses the shared editor", async ({ page, request }) => {
  const { id } = await seedFile(request);
  await page.goto(`/slideshow?file=${id}`);
  await expect(page.getByRole("heading", { name: "Slideshow", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Add quote/ })).toBeVisible();
  await expect(page.getByLabel("Quote", { exact: true })).toHaveValue("QuoteText");
  await page.goto("/slideshow");
  await expect(page.getByLabel("Files page ID")).toBeVisible();
  await page.goto("/slideshow?file=999999999");
  await expect(page.getByText("No file with id 999999999")).toBeVisible();
});
