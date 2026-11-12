import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DATA_DIR } from "@/lib/data-dir";
import { VIDEO_MAX_MB } from "./duration";
import { validateMusic, type Music } from "./music";

export type PhotoSlide = { id: string; type: "photo"; photo: string; caption?: string };
export type QuoteSlide = { id: string; type: "quote"; text: string; name: string };
export type VideoSlide = { id: string; type: "video"; video: string; caption?: string };
export type Slide = PhotoSlide | QuoteSlide | VideoSlide;
export type Slideshow = { key: string; title: string; unlockLocal?: string; slides: Slide[]; music?: Music; updatedAt?: string };

export const BIRTHDAY_KEY = "partner-birthday";
export const BIRTHDAY_DEFAULT_UNLOCK = "2026-10-31 18:00"; // Saturday 6:00 PM Central
export const MAX_SLIDES = 80;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_BYTES = VIDEO_MAX_MB * 1024 * 1024;
export const MAX_VIDEO_TOTAL_BYTES = 2 * 1024 ** 3;
const MAX_PHOTO_FILES = 300;
const KEY_RE = /^(partner-birthday|file-[1-9][0-9]{0,11})$/;
const PHOTO_RE = /^[a-f0-9]{24}\.(jpg|png|webp|gif|mp4|webm)$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const LOCAL_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d$/;
export const PHOTO_MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" };

export const isValidKey = (k: unknown): k is string => typeof k === "string" && KEY_RE.test(k);
export const isValidPhotoId = (p: unknown): p is string => typeof p === "string" && PHOTO_RE.test(p);
export const isVideoId = (p: unknown): p is string => typeof p === "string" && PHOTO_RE.test(p) && /\.(mp4|webm)$/.test(p);

const root = () => path.join(DATA_DIR, "slideshows");
const jsonFile = (key: string) => path.join(root(), `${key}.json`);
const photoDir = (key: string) => path.join(root(), key);

function defaults(key: string): Slideshow {
  return key === BIRTHDAY_KEY
    ? { key, title: "Our story, my love", unlockLocal: BIRTHDAY_DEFAULT_UNLOCK, slides: [] }
    : { key, title: "Slideshow", slides: [] };
}

/** Read-only. Missing file = defaults (never writes). */
export function readSlideshow(key: string): Slideshow {
  if (!isValidKey(key)) throw new Error("bad slideshow key");
  try {
    const s = JSON.parse(fs.readFileSync(jsonFile(key), "utf8")) as Slideshow;
    return { ...defaults(key), ...s, key, slides: Array.isArray(s.slides) ? s.slides : [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return defaults(key);
    throw e;
  }
}

export function listSlideshows(): { key: string; title: string; count: number }[] {
  let names: string[] = [];
  try { names = fs.readdirSync(root()); } catch { return []; }
  return names
    .filter((n) => n.endsWith(".json") && isValidKey(n.slice(0, -5)))
    .map((n) => { const s = readSlideshow(n.slice(0, -5)); return { key: s.key, title: s.title, count: s.slides.length }; });
}

export function saveSlideshow(s: Slideshow) {
  fs.mkdirSync(root(), { recursive: true });
  const f = jsonFile(s.key);
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, f);
}

export function validateSlideshow(key: string, body: unknown): { ok: true; value: Slideshow } | { ok: false; error: string } {
  if (!isValidKey(key)) return { ok: false, error: "Bad slideshow" };
  const b = body as { title?: unknown; unlockLocal?: unknown; slides?: unknown; music?: unknown };
  if (!b || typeof b !== "object") return { ok: false, error: "Invalid body" };
  if (!Array.isArray(b.slides) || b.slides.length > MAX_SLIDES) return { ok: false, error: `Max ${MAX_SLIDES} slides` };
  const title = typeof b.title === "string" ? b.title.trim().slice(0, 120) : "";
  let unlockLocal: string | undefined;
  if (b.unlockLocal != null && b.unlockLocal !== "") {
    if (typeof b.unlockLocal !== "string" || !LOCAL_RE.test(b.unlockLocal)) return { ok: false, error: "Bad unlock time" };
    unlockLocal = b.unlockLocal;
  }
  const ids = new Set<string>();
  const slides: Slide[] = [];
  for (const r of b.slides as Record<string, unknown>[]) {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || !ID_RE.test(r.id) || ids.has(r.id)) return { ok: false, error: "Bad slide id" };
    ids.add(r.id);
    if (r.type === "photo") {
      if (!isValidPhotoId(r.photo) || !fs.existsSync(path.join(photoDir(key), r.photo))) return { ok: false, error: "Photo not found" };
      if (r.caption != null && (typeof r.caption !== "string" || r.caption.length > 200)) return { ok: false, error: "Caption over 200 characters" };
      const caption = typeof r.caption === "string" ? r.caption.trim() : "";
      slides.push({ id: r.id, type: "photo", photo: r.photo, ...(caption ? { caption } : {}) });
    } else if (r.type === "quote") {
      if (typeof r.text !== "string" || !r.text.trim() || r.text.length > 800) return { ok: false, error: "Each quote needs text (max 800 characters)" };
      if (typeof r.name !== "string" || r.name.length > 80) return { ok: false, error: "Name over 80 characters" };
      slides.push({ id: r.id, type: "quote", text: r.text.trim(), name: r.name.trim() });
    } else if (r.type === "video") {
      if (!isVideoId(r.video) || !fs.existsSync(path.join(photoDir(key), r.video))) return { ok: false, error: "Video not found" };
      if (r.caption != null && (typeof r.caption !== "string" || r.caption.length > 200)) return { ok: false, error: "Caption over 200 characters" };
      const caption = typeof r.caption === "string" ? r.caption.trim() : "";
      slides.push({ id: r.id, type: "video", video: r.video, ...(caption ? { caption } : {}) });
    } else return { ok: false, error: "Bad slide type" };
  }
  const mus = validateMusic(key, b.music);
  if (!mus.ok) return { ok: false, error: mus.error };
  const d = defaults(key);
  const unlock = unlockLocal || d.unlockLocal;
  return { ok: true, value: { key, title: title || d.title, ...(unlock ? { unlockLocal: unlock } : {}), slides, ...(mus.value ? { music: mus.value } : {}) } };
}

const SIGS: [string, (b: Buffer) => boolean][] = [
  ["jpg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  ["webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];

export function savePhoto(key: string, buf: Buffer): { ok: true; photo: string } | { ok: false; error: string } {
  if (!isValidKey(key)) return { ok: false, error: "Bad slideshow" };
  if (buf.length === 0) return { ok: false, error: "That file is empty." };
  if (buf.length > MAX_PHOTO_BYTES) return { ok: false, error: "Photo is over 8 MB." };
  const ext = SIGS.find(([, test]) => test(buf))?.[0];
  if (!ext) return { ok: false, error: "Only JPEG, PNG, WebP or GIF photos." };
  const dir = photoDir(key);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length >= MAX_PHOTO_FILES) return { ok: false, error: `Photo limit reached (${MAX_PHOTO_FILES}).` };
  const photo = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
  const dest = path.join(dir, photo);
  fs.writeFileSync(dest + ".tmp", buf);
  fs.renameSync(dest + ".tmp", dest);
  return { ok: true, photo };
}

export async function saveVideo(key: string, file: File): Promise<{ ok: true; video: string } | { ok: false; error: string }> {
  if (!isValidKey(key)) return { ok: false, error: "Bad slideshow" };
  const size = file.size;
  if (size === 0) return { ok: false, error: "That file is empty." };
  if (size > MAX_VIDEO_BYTES) return { ok: false, error: "Video is over 200 MB. Please shorten or compress it to under 5 minutes." };
  const head = Buffer.from(await file.slice(0, 12).arrayBuffer());
  const ext = head.subarray(4, 8).toString("latin1") === "ftyp" ? "mp4"
    : head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? "webm" : null;
  if (!ext) return { ok: false, error: "Only MP4 or WebM videos." };
  const dir = photoDir(key);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const st = fs.statfsSync(dir);
    if (st.bavail * st.bsize < size + 1024 ** 3) return { ok: false, error: "Not enough free disk space for this video." };
  } catch { return { ok: false, error: "Not enough free disk space for this video." }; }
  const names = fs.readdirSync(dir);
  if (names.length >= MAX_PHOTO_FILES) return { ok: false, error: `Photo limit reached (${MAX_PHOTO_FILES}).` };
  let used = 0;
  for (const n of names) {
    if (/\.(mp4|webm)$/.test(n)) { try { used += fs.statSync(path.join(dir, n)).size; } catch { /* ignore */ } }
  }
  if (used + size > MAX_VIDEO_TOTAL_BYTES) return { ok: false, error: "Video storage for this slideshow is full (2 GB)." };
  const video = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
  const dest = path.join(dir, video);
  const tmp = dest + ".tmp";
  try {
    await pipeline(Readable.fromWeb(file.stream() as unknown as import("node:stream/web").ReadableStream), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: "Couldn't save the video. Please try again." };
  }
  return { ok: true, video };
}

/** Absolute path of a stored photo/video, or null if ids are invalid or the file is missing. */
export function photoPath(key: string, photo: string): string | null {
  if (!isValidKey(key) || !isValidPhotoId(photo)) return null;
  const p = path.join(photoDir(key), photo);
  return fs.existsSync(p) ? p : null;
}

export function readPhoto(key: string, photo: string): { buf: Buffer; mime: string } | null {
  if (!isValidKey(key) || !isValidPhotoId(photo)) return null;
  try { return { buf: fs.readFileSync(path.join(photoDir(key), photo)), mime: PHOTO_MIME[photo.split(".")[1]] }; } catch { return null; }
}
