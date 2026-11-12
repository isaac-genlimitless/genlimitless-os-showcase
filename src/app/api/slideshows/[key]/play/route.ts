import { isValidKey, readSlideshow } from "@/lib/slideshow/store";
import { renderSlideshowPlayer, PLAYER_CSP } from "@/lib/slideshow/player";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const key = (await params).key;
  if (!isValidKey(key)) return Response.json({ error: "not found" }, { status: 404 });
  const s = readSlideshow(key);
  const html = renderSlideshowPlayer({ title: s.title, slides: s.slides, photoUrl: (p) => `/api/slideshows/${key}/photos/${p}`, music: s.music ? { src: `/api/slideshows/${key}/music/${s.music.file}`, volume: s.music.volume } : undefined });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": PLAYER_CSP } });
}
