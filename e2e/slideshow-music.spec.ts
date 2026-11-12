import { test, expect } from "./isolated-test";
import { validateSlideshow } from "../src/lib/slideshow/store";
import { renderSlideshowPlayer } from "../src/lib/slideshow/player";

// Never presses Send or triggers an agent. Runs only against the isolated server.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
type PlayerOpts = Parameters<typeof renderSlideshowPlayer>[0];
/** 0.2 second silent 8-bit mono WAV (valid RIFF/WAVE header). */
function wav(): Buffer {
  const n = 1600, h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + n, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28);
  h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.write("data", 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.alloc(n, 128)]);
}

async function makeFile(request: import("@playwright/test").APIRequestContext) {
  const created = await request.post("/api/files", { data: { title: "Music test" } });
  expect(created.ok()).toBeTruthy();
  return (await created.json()).page.id as number;
}
async function photo(request: import("@playwright/test").APIRequestContext, api: string) {
  const ph = await request.post(`${api}/photos`, { multipart: { file: { name: "a.png", mimeType: "image/png", buffer: PNG } } });
  return (await ph.json()).photo as string;
}

test("pure: bad music is refused; player only has music controls when a track is set", () => {
  expect(validateSlideshow("file-1", { slides: [], music: { file: "../x.wav" } }).ok).toBe(false);
  expect(validateSlideshow("file-1", { slides: [], music: { file: "aaaaaaaaaaaaaaaaaaaaaaaa.wav" } }).ok).toBe(false); // does not exist
  expect(validateSlideshow("file-1", { slides: [] }).ok).toBe(true); // no music is fine
  const none = renderSlideshowPlayer({ title: "T", slides: [{ id: "q", type: "quote", text: "Hi", name: "Mom" }], photoUrl: (p: string) => `/x/${p}` });
  expect(none).not.toContain('id="bgm"');
  expect(none).not.toContain('id="mus"');
  const withMusic = renderSlideshowPlayer({ title: "T", slides: [{ id: "q", type: "quote", text: "Hi", name: "Mom" }], photoUrl: (p: string) => `/x/${p}`, music: { src: "/m/a.wav", volume: 0.4 } } as unknown as PlayerOpts);
  expect(withMusic).toContain('id="bgm"');
  expect(withMusic).toContain("loop");
  expect(withMusic).toContain('id="mus"');
  expect(withMusic).toContain("/m/a.wav");
  expect(withMusic).toContain("!vid"); // music is paused while a video slide plays
});

test("api: music upload, validation, save, remove and range requests", async ({ request }) => {
  const id = await makeFile(request);
  const api = `/api/slideshows/file-${id}`;
  const up = await request.post(`${api}/music`, { multipart: { file: { name: "song.wav", mimeType: "audio/wav", buffer: wav() } } });
  expect(up.status()).toBe(200);
  const { music } = await up.json();
  expect(music.file).toMatch(/^[a-f0-9]{24}\.wav$/);
  expect((await request.post(`${api}/music`, { multipart: { file: { name: "x.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("<html>") } } })).status()).toBe(400);
  expect((await request.post(`${api}/music`, { multipart: { file: { name: "e.wav", mimeType: "audio/wav", buffer: Buffer.alloc(0) } } })).status()).toBe(400);
  expect((await request.put(api, { data: { title: "M", slides: [], music: { file: music.file, volume: 5 } } })).status()).toBe(400);
  expect((await request.put(api, { data: { title: "M", slides: [], music: { file: "../x.wav", volume: 0.5 } } })).status()).toBe(400);
  const put = await request.put(api, { data: { title: "M", slides: [], music: { file: music.file, volume: 0.3 } } });
  expect(put.status()).toBe(200);
  const got = await (await request.get(api)).json();
  expect(got.music).toEqual({ file: music.file, volume: 0.3 });
  const part = await request.get(`${api}/music/${music.file}`, { headers: { Range: "bytes=0-3" } });
  expect(part.status()).toBe(206);
  expect((await part.body()).length).toBe(4);
  const full = await request.get(`${api}/music/${music.file}`);
  expect(full.status()).toBe(200);
  expect(full.headers()["content-type"]).toContain("audio/wav");
  expect((await request.get(`${api}/music/${music.file}`, { headers: { Range: "bytes=999999999-" } })).status()).toBe(416);
  expect((await request.get(`${api}/music/not-a-file.wav`)).status()).toBe(404);
  // Removing music from the show keeps the file on disk.
  expect((await request.put(api, { data: { title: "M", slides: [] } })).status()).toBe(200);
  expect((await (await request.get(api)).json()).music).toBeUndefined();
  expect((await request.get(`${api}/music/${music.file}`)).status()).toBe(200);
});

test("ui: editor can add, set volume, save and remove music", async ({ page, request }) => {
  const id = await makeFile(request);
  const api = `/api/slideshows/file-${id}`;
  await request.put(api, { data: { title: "UI", slides: [{ id: "p1", type: "photo", photo: await photo(request, api) }] } });
  await page.goto(`/slideshow?file=${id}`);
  await expect(page.getByTestId("music-control")).toBeVisible();
  await expect(page.getByText("🎵 Add music")).toBeVisible();
  await page.locator('[data-testid="music-control"] input[type="file"]').setInputFiles({ name: "song.wav", mimeType: "audio/wav", buffer: wav() });
  const slider = page.getByLabel("Music volume");
  await expect(slider).toBeVisible();
  await slider.fill("40");
  await page.getByRole("button", { name: "Save slideshow" }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  const saved = await (await request.get(api)).json();
  expect(saved.music.file).toMatch(/\.wav$/);
  expect(saved.music.volume).toBeCloseTo(0.4, 2);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove music" }).click();
  await page.getByRole("button", { name: "Save slideshow" }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  expect((await (await request.get(api)).json()).music).toBeUndefined();
});

test("player: music starts on tap, loops, mutes/unmutes, and keeps playing through Shuffle/Reset", async ({ page, request }) => {
  const id = await makeFile(request);
  const api = `/api/slideshows/file-${id}`;
  const up = await request.post(`${api}/music`, { multipart: { file: { name: "song.wav", mimeType: "audio/wav", buffer: wav() } } });
  const { music } = await up.json();
  const p = await photo(request, api);
  const slides = [1, 2, 3, 4].map((n) => ({ id: `p${n}`, type: "photo", photo: p }));
  await request.put(api, { data: { title: "Play", slides, music: { file: music.file, volume: 0.4 } } });
  await page.goto(`${api}/play`);
  const bgm = page.locator("#bgm");
  await expect(bgm).toHaveCount(1);
  await expect(bgm).toHaveJSProperty("loop", true);
  expect(await bgm.evaluate((a) => (a as HTMLAudioElement).volume)).toBeCloseTo(0.4, 2);
  // Browsers need a tap first: a tap on Shuffle both shuffles and starts the music.
  await page.locator("#shuf").click();
  await expect.poll(() => bgm.evaluate((a) => (a as HTMLAudioElement).paused)).toBe(false);
  await expect(page.locator("#orig")).toBeVisible();
  // Mute / unmute
  await page.locator("#mus").click();
  await expect(page.locator("#mus")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => bgm.evaluate((a) => (a as HTMLAudioElement).paused)).toBe(true);
  await page.locator("#mus").click();
  await expect(page.locator("#mus")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => bgm.evaluate((a) => (a as HTMLAudioElement).paused)).toBe(false);
  // Reset (restore original order) and Shuffle again: music keeps going.
  await page.locator("#orig").click();
  await page.locator("#shuf").click();
  expect(await bgm.evaluate((a) => (a as HTMLAudioElement).paused)).toBe(false);
  // Pausing the slideshow pauses the music; playing resumes it.
  await page.locator("#play").click();
  await expect.poll(() => bgm.evaluate((a) => (a as HTMLAudioElement).paused)).toBe(true);
  await page.locator("#play").click();
  await expect.poll(() => bgm.evaluate((a) => (a as HTMLAudioElement).paused)).toBe(false);
});
