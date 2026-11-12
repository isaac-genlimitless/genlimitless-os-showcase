import { isValidKey, saveVideo, MAX_VIDEO_BYTES } from "@/lib/slideshow/store";
import { getPage } from "@/lib/pages";

export const dynamic = "force-dynamic";
const bad = (m: string, s = 400) => Response.json({ error: m }, { status: s });

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const key = (await params).key;
  if (!isValidKey(key) || (key.startsWith("file-") && !getPage(Number(key.slice(5))))) return bad("Not found", 404);
  let form: FormData;
  try { form = await req.formData(); } catch { return bad("Couldn't read the upload."); }
  const file = form.get("file");
  if (!(file instanceof File)) return bad("No video chosen.");
  if (file.size > MAX_VIDEO_BYTES) return bad("Video is over 200 MB. Please shorten or compress it to under 5 minutes.", 413);
  const r = await saveVideo(key, file);
  if (!r.ok) return bad(r.error);
  return Response.json({ ok: true, video: r.video });
}
