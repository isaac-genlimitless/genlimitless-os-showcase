import { isValidKey, savePhoto, MAX_PHOTO_BYTES } from "@/lib/slideshow/store";
import { getPage } from "@/lib/pages";

export const dynamic = "force-dynamic";
const bad = (m: string, s = 400) => Response.json({ error: m }, { status: s });

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const key = (await params).key;
  if (!isValidKey(key) || (key.startsWith("file-") && !getPage(Number(key.slice(5))))) return bad("Not found", 404);
  let form: FormData;
  try { form = await req.formData(); } catch { return bad("Couldn't read the upload."); }
  const file = form.get("file");
  if (!(file instanceof File)) return bad("No photo chosen.");
  if (file.size > MAX_PHOTO_BYTES) return bad("Photo is over 8 MB.", 413);
  const r = savePhoto(key, Buffer.from(await file.arrayBuffer()));
  if (!r.ok) return bad(r.error);
  return Response.json({ ok: true, photo: r.photo });
}
