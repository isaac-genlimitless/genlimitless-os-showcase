"use client";
/** Embeds THE slideshow player (rendered by src/lib/slideshow/player.ts) so there is one implementation. */
export default function SlideshowPlayer({ src, title, height = 560 }: { src: string; title: string; height?: number }) {
  return <iframe src={src} title={title} style={{ width: "100%", height, border: 0, borderRadius: 16, background: "#fff8e7" }} allow="fullscreen" />;
}
