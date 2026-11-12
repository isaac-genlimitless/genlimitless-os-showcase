import { test, expect } from "./isolated-test";
import { slideDurationMs, VIDEO_MAX_SECONDS, VIDEO_MAX_MB } from "../src/lib/slideshow/duration";
import { validateSlideshow } from "../src/lib/slideshow/store";
import { renderSlideshowPlayer, PLAYER_CSP } from "../src/lib/slideshow/player";

// Never presses Send or triggers an agent. Runs only against the isolated server.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
// Tiny buffer with an MP4 "ftyp" header; enough for the upload check, not decodable.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2"), Buffer.alloc(32)]);

test("pure: 5-minute rule, validation, player output and CSP", () => {
  expect(slideDurationMs({ type: "video" } as never)).toBe(300000);
  expect(VIDEO_MAX_SECONDS).toBe(300);
  expect(VIDEO_MAX_MB).toBe(200);
  expect(validateSlideshow("file-1", { slides: [{ id: "a", type: "video" }] }).ok).toBe(false);
  expect(validateSlideshow("file-1", { slides: [{ id: "a", type: "video", video: "../x.mp4" }] }).ok).toBe(false);
  const html = renderSlideshowPlayer({
    title: "T",
    slides: [
      { id: "p", type: "photo", photo: "a.png" },
      { id: "v", type: "video", video: "a.mp4" },
      { id: "q", type: "quote", text: "Hi", name: "Mom" },
    ] as never,
    photoUrl: (p) => `/x/${p}`,
  });
  expect(html).toContain("createElement");
  expect(html).toContain("video");
  expect(html).toContain("/x/a.mp4");
  expect(html).toContain("/x/a.png");
  expect(html).toContain("Mom");
  expect(PLAYER_CSP).toContain("media-src 'self'");
});

async function makeFile(request: import("@playwright/test").APIRequestContext) {
  const created = await request.post("/api/files", { data: { title: "Video test" } });
  expect(created.ok()).toBeTruthy();
  return (await created.json()).page.id as number;
}

test("api: video upload, save, and range requests", async ({ request }) => {
  const id = await makeFile(request);
  const api = `/api/slideshows/file-${id}`;
  const up = await request.post(`${api}/videos`, { multipart: { file: { name: "c.mp4", mimeType: "video/mp4", buffer: MP4 } } });
  expect(up.status()).toBe(200);
  const { video } = await up.json();
  expect(video).toMatch(/\.mp4$/);
  const bad = await request.post(`${api}/videos`, { multipart: { file: { name: "x.mp4", mimeType: "video/mp4", buffer: Buffer.from("<html>") } } });
  expect(bad.status()).toBe(400);
  const empty = await request.post(`${api}/videos`, { multipart: { file: { name: "e.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(0) } } });
  expect(empty.status()).toBe(400);
  const ph = await request.post(`${api}/photos`, { multipart: { file: { name: "a.png", mimeType: "image/png", buffer: PNG } } });
  const { photo } = await ph.json();
  const put = await request.put(api, { data: { title: "Mix", slides: [{ id: "p1", type: "photo", photo }, { id: "v1", type: "video", video }, { id: "q1", type: "quote", text: "Hello", name: "Mom" }] } });
  expect(put.status()).toBe(200);
  const got = await (await request.get(api)).json();
  expect(got.slides.map((s: { type: string }) => s.type)).toEqual(["photo", "video", "quote"]);
  const part = await request.get(`${api}/photos/${video}`, { headers: { Range: "bytes=0-3" } });
  expect(part.status()).toBe(206);
  expect(part.headers()["content-range"]).toBeTruthy();
  expect((await part.body()).length).toBe(4);
  const full = await request.get(`${api}/photos/${video}`);
  expect(full.status()).toBe(200);
  expect(full.headers()["content-type"]).toContain("video/mp4");
  const unsat = await request.get(`${api}/photos/${video}`, { headers: { Range: "bytes=999999999-" } });
  expect(unsat.status()).toBe(416);
});

test("ui: editor shows Add video, the 5 minute / 200 MB note, and photo rows keep their label", async ({ page, request }) => {
  const id = await makeFile(request);
  const api = `/api/slideshows/file-${id}`;
  const ph = await request.post(`${api}/photos`, { multipart: { file: { name: "a.png", mimeType: "image/png", buffer: PNG } } });
  const { photo } = await ph.json();
  await request.put(api, { data: { title: "UI", slides: [{ id: "p1", type: "photo", photo }] } });
  await page.goto(`/slideshow?file=${id}`);
  await expect(page.getByText("🎬 Add video")).toBeVisible();
  await expect(page.locator('input[type="file"][accept="video/mp4,video/webm,video/quicktime"]')).toHaveCount(1);
  await expect(page.getByText("up to 5 minutes and 200 MB")).toBeVisible();
  await expect(page.getByText("Photo · 3s")).toBeVisible();
});

test("player: video slide present, no photo-timer advance, photo advances at 3s", async ({ page, request }) => {
  const id = await makeFile(request);
  const api = `/api/slideshows/file-${id}`;
  const ph = await request.post(`${api}/photos`, { multipart: { file: { name: "a.png", mimeType: "image/png", buffer: PNG } } });
  const { photo } = await ph.json();
  const up = await request.post(`${api}/videos`, { multipart: { file: { name: "c.mp4", mimeType: "video/mp4", buffer: MP4 } } });
  const { video } = await up.json();
  await request.put(api, { data: { title: "Play", slides: [{ id: "p1", type: "photo", photo }, { id: "v1", type: "video", video }] } });
  await page.goto(`${api}/play`);
  // Photo first; it advances after ~3s to the video slide.
  await expect(page.locator("#stage img")).toBeVisible();
  await expect(page.locator("#stage video")).toHaveCount(1, { timeout: 6000 });
  // The fixture isn't decodable, so the clip takes the error path (1.5s) instead of the 3s photo timer.
  await page.waitForTimeout(500);
  await expect(page.locator("#stage video")).toHaveCount(1);
});
