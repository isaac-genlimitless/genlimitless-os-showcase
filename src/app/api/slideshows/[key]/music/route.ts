import { isValidKey } from "@/lib/slideshow/store";
import { saveMusic } from "@/lib/slideshow/music";
import { MAX_MUSIC_BYTES } from "@/lib/slideshow/music-limits";
import { getPage } from "@/lib/pages";

export const dynamic = "force-dynamic";
const bad = (m: string, s = 400) => Response.json({ error: m }, { status: s });

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const key = (await params).key;
  if (!isValidKey(key) || (key.startsWith("file-") && !getPage(Number(key.slice(5))))) return bad("Not found", 404);
  let form: FormData;
  try { form = await req.formData(); } catch { return bad("Couldn't read the upload."); }
  const file = form.get("file");
  if (!(file instanceof File)) return bad("No music chosen.");
  if (file.size > MAX_MUSIC_BYTES) return bad("Music is over 50 MB. Please use a shorter or smaller file.", 413);
  const r = await saveMusic(key, file);
  if (!r.ok) return bad(r.error);
  return Response.json({ ok: true, music: r.music });
}
