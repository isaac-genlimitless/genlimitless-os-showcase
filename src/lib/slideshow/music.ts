import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DATA_DIR } from "@/lib/data-dir";
import { MAX_MUSIC_BYTES, DEFAULT_MUSIC_VOLUME } from "./music-limits";

export type Music = { file: string; volume: number };
const KEY_RE = /^(partner-birthday|file-[1-9][0-9]{0,11})$/;
export const MUSIC_RE = /^[a-f0-9]{24}\.(mp3|m4a|wav)$/;
export const MUSIC_MIME: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav" };
export const isMusicId = (f: unknown): f is string => typeof f === "string" && MUSIC_RE.test(f);
export const musicMime = (file: string) => MUSIC_MIME[file.split(".")[1]] || "application/octet-stream";
// Same folder as the slideshow's photos/videos (DATA_DIR/slideshows/<key>/).
const dirOf = (key: string) => path.join(DATA_DIR, "slideshows", key);

/** Absolute path of a stored music file, or null if key/id are invalid or the file is missing. */
export function musicPath(key: string, file: string): string | null {
  if (!KEY_RE.test(key) || !isMusicId(file)) return null;
  const p = path.join(dirOf(key), file);
  return fs.existsSync(p) ? p : null;
}

/** Content sniffing (never trust the file name or MIME type). */
function sniff(h: Buffer): "mp3" | "m4a" | "wav" | null {
  if (h.subarray(0, 4).toString("latin1") === "RIFF" && h.subarray(8, 12).toString("latin1") === "WAVE") return "wav";
  if (h.subarray(4, 8).toString("latin1") === "ftyp") return "m4a";
  if (h.subarray(0, 3).toString("latin1") === "ID3" || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) return "mp3";
  return null;
}

export async function saveMusic(key: string, file: File): Promise<{ ok: true; music: Music } | { ok: false; error: string }> {
  if (!KEY_RE.test(key)) return { ok: false, error: "Bad slideshow" };
  const size = file.size;
  if (size === 0) return { ok: false, error: "That file is empty." };
  if (size > MAX_MUSIC_BYTES) return { ok: false, error: "Music is over 50 MB. Please use a shorter or smaller file." };
  const ext = sniff(Buffer.from(await file.slice(0, 12).arrayBuffer()));
  if (!ext) return { ok: false, error: "Only MP3, M4A or WAV music." };
  const dir = dirOf(key);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const st = fs.statfsSync(dir);
    if (st.bavail * st.bsize < size + 1024 ** 3) return { ok: false, error: "Not enough free disk space for this music." };
  } catch { return { ok: false, error: "Not enough free disk space for this music." }; }
  const name = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
  const dest = path.join(dir, name);
  const tmp = dest + ".tmp";
  try {
    await pipeline(Readable.fromWeb(file.stream() as unknown as import("node:stream/web").ReadableStream), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: "Couldn't save the music. Please try again." };
  }
  return { ok: true, music: { file: name, volume: DEFAULT_MUSIC_VOLUME } };
}

/** null/undefined = no music. Otherwise { file, volume 0..1 } and the file must exist. */
export function validateMusic(key: string, raw: unknown): { ok: true; value: Music | undefined } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: undefined };
  const m = raw as { file?: unknown; volume?: unknown };
  if (typeof m !== "object" || !isMusicId(m.file) || !musicPath(key, m.file)) return { ok: false, error: "Music file not found" };
  let volume = DEFAULT_MUSIC_VOLUME;
  if (m.volume != null) {
    if (typeof m.volume !== "number" || !Number.isFinite(m.volume) || m.volume < 0 || m.volume > 1) return { ok: false, error: "Music volume must be between 0 and 1" };
    volume = Math.round(m.volume * 100) / 100;
  }
  return { ok: true, value: { file: m.file, volume } };
}
