import { isValidKey, readSlideshow, saveSlideshow, validateSlideshow } from "@/lib/slideshow/store";
import { getPage } from "@/lib/pages";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ key: string }> };
const bad = (m: string, s = 400) => Response.json({ error: m }, { status: s });
const known = (key: string) => isValidKey(key) && (!key.startsWith("file-") || !!getPage(Number(key.slice(5))));

export async function GET(_req: Request, { params }: Ctx) {
  const key = (await params).key;
  if (!known(key)) return bad("Not found", 404);
  return Response.json(readSlideshow(key));
}

// Same-origin is already enforced for writes by src/lib/auth/policy.ts:46.
export async function PUT(req: Request, { params }: Ctx) {
  const key = (await params).key;
  if (!known(key)) return bad("Not found", 404);
  let body: unknown;
  try { body = await req.json(); } catch { return bad("Invalid JSON"); }
  const v = validateSlideshow(key, body);
  if (!v.ok) return bad(v.error);
  saveSlideshow(v.value);
  return Response.json({ ok: true, slideshow: readSlideshow(key) });
}
