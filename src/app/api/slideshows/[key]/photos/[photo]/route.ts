import { readPhoto, photoPath } from "@/lib/slideshow/store";
import { streamMedia } from "@/lib/slideshow/media-response";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ key: string; photo: string }> }) {
  const { key, photo } = await params;
  const vm = /\.(mp4|webm)$/i.exec(photo);
  if (vm) {
    const vp = photoPath(key, photo);
    if (!vp) return Response.json({ error: "not found" }, { status: 404 });
    return streamMedia(vp, vm[1].toLowerCase() === "webm" ? "video/webm" : "video/mp4", req.headers.get("range"), { "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
  }
  const p = readPhoto(key, photo);
  if (!p) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(new Uint8Array(p.buf), {
    headers: { "Content-Type": p.mime, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
  });
}
