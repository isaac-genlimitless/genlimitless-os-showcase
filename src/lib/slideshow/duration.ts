/** How long each slide stays on screen. Shared by the player and the editor. */
export const PHOTO_MS = 3000;
export const VIDEO_MAX_SECONDS = 300;
export const VIDEO_MAX_MS = VIDEO_MAX_SECONDS * 1000;
export const VIDEO_MAX_MB = 200;
export function slideDurationMs(s: { type: string; text?: string }): number {
  if (s.type === "video") return VIDEO_MAX_MS; // placeholder: the player uses the real clip length
  if (s.type !== "quote") return PHOTO_MS;
  const words = (s.text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.min(15000, 3000 + Math.max(0, words - 10) * 300);
}
