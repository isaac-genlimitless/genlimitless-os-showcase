import { test, expect } from "./isolated-test";
import { slideDurationMs } from "../src/lib/slideshow/duration";
import { validateSlideshow, isValidKey } from "../src/lib/slideshow/store";
import { renderSlideshowPlayer } from "../src/lib/slideshow/player";

// Never presses Send or triggers an agent. Runs only against the isolated server.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test("photos are 3s; quote time grows with words, capped at 15s", () => {
  expect(slideDurationMs({ type: "photo" })).toBe(3000);
  expect(slideDurationMs({ type: "quote", text: "one two three four five six seven eight nine ten" })).toBe(3000);
  expect(slideDurationMs({ type: "quote", text: Array(20).fill("w").join(" ") })).toBe(6000);
  expect(slideDurationMs({ type: "quote", text: Array(300).fill("w").join(" ") })).toBe(15000);
});

test("keys and slides are validated", () => {
  expect(isValidKey("partner-birthday")).toBe(true);
  expect(isValidKey("file-12")).toBe(true);
  expect(isValidKey("../etc")).toBe(false);
  expect(isValidKey("file-0")).toBe(false);
  expect(validateSlideshow("file-1", { slides: [{ id: "a", type: "video" }] }).ok).toBe(false);
  expect(validateSlideshow("file-1", { slides: [{ id: "a", type: "photo", photo: "../../x.jpg" }] }).ok).toBe(false);
  expect(validateSlideshow("file-1", { slides: [{ id: "a", type: "quote", text: "", name: "" }] }).ok).toBe(false);
  expect(validateSlideshow("file-1", { slides: [{ id: "a", type: "quote", text: "Hi", name: "Mom" }] }).ok).toBe(true);
});

test("player escapes slide text and line separators", () => {
  const sep = String.fromCharCode(0x2028);
  const html = renderSlideshowPlayer({ title: "<b>T</b>", slides: [{ id: "q", type: "quote", text: "</script><img src=x>" + sep, name: "N" }], photoUrl: (p) => p });
  expect(html).not.toContain("</script><img");
  expect(html).not.toContain("<b>T</b>");
  expect(html).not.toContain(sep);
});

test("upload, save and read back a slideshow on a Files page; junk refused", async ({ request }) => {
  const created = await request.post("/api/files", { data: { title: "Family photos" } });
  expect(created.ok()).toBeTruthy();
  const id = (await created.json()).page.id as number;
  const api = `/api/slideshows/file-${id}`;
  const junk = await request.post(`${api}/photos`, { multipart: { file: { name: "x.png", mimeType: "image/png", buffer: Buffer.from("<html><script>") } } });
  expect(junk.status()).toBe(400);
  const up = await request.post(`${api}/photos`, { multipart: { file: { name: "a.png", mimeType: "image/png", buffer: PNG } } });
  expect(up.ok()).toBeTruthy();
  const { photo } = await up.json();
  const put = await request.put(api, { data: { title: "Trip", slides: [{ id: "p1", type: "photo", photo }, { id: "q1", type: "quote", text: "Hello there", name: "Mom" }] } });
  expect(put.ok()).toBeTruthy();
  const got = await (await request.get(api)).json();
  expect(got.slides.map((s: { type: string }) => s.type)).toEqual(["photo", "quote"]);
  expect((await request.get("/api/slideshows/file-999999999")).status()).toBe(404);
});
