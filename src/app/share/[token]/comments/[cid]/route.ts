import { CAPS, clientIp, CommentError, originOk, publicComment, rateLimit, sanitizeText, setResolved } from "@/lib/file-comments";
import { getSharedPage } from "@/lib/pages";

export const dynamic = "force-dynamic";

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Type": "application/json; charset=utf-8",
};
const MAX_BYTES = 8192;

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...HEADERS, ...extra } });
}

// POST {resolved:boolean, author?:string}. Token validated first on every request.
export async function POST(req: Request, { params }: { params: Promise<{ token: string; cid: string }> }) {
  const p = await params;
  const page = getSharedPage(p.token);
  if (!page) return json({ error: "not found" }, 404);
  if (!originOk(req)) return json({ error: "forbidden" }, 403);
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (!ctype.startsWith("application/json")) return json({ error: "JSON only" }, 415);

  const wait = rateLimit(p.token + "|" + clientIp(req));
  if (wait > 0) return json({ error: "too many requests" }, 429, { "Retry-After": String(wait) });

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return json({ error: "too large" }, 413);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const input = data as Record<string, unknown> | null;
  if (!input || typeof input !== "object" || typeof input.resolved !== "boolean") return json({ error: "resolved (boolean) required" }, 400);
  const author = sanitizeText(input.author, CAPS.author);
  if (!author) return json({ error: "name required" }, 400);

  try {
    const c = setResolved(page.id, Number(p.cid), input.resolved, author);
    return json({ comment: publicComment(c) });
  } catch (e) {
    if (e instanceof CommentError) return json({ error: e.message }, e.status);
    throw e;
  }
}
