import { musicPath, musicMime } from "@/lib/slideshow/music";
import { streamMedia } from "@/lib/slideshow/media-response";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ key: string; file: string }> }) {
  const { key, file } = await params;
  const p = musicPath(key, file);
  if (!p) return Response.json({ error: "not found" }, { status: 404 });
  return streamMedia(p, musicMime(file), req.headers.get("range"), { "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
}
