import { addComment, clientIp, CommentError, listComments, notifyOwner, originOk, publicComment, rateLimit, sanitizeText, CAPS } from "@/lib/file-comments";
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

// Public (token-gated). Every request validates the share token first; bad/revoked/trashed = 404.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const page = getSharedPage((await params).token);
  if (!page) return json({ error: "not found" }, 404);
  return json({ comments: listComments(page.id).map(publicComment) });
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token;
  const page = getSharedPage(token);
  if (!page) return json({ error: "not found" }, 404);
  if (!originOk(req)) return json({ error: "forbidden" }, 403);
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (!ctype.startsWith("application/json")) return json({ error: "JSON only" }, 415);

  const wait = rateLimit(token + "|" + clientIp(req));
  if (wait > 0) return json({ error: "too many requests" }, 429, { "Retry-After": String(wait) });

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return json({ error: "too large" }, 413);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return json({ error: "invalid JSON" }, 400);
  const input = data as Record<string, unknown>;
  const author = sanitizeText(input.author, CAPS.author);
  if (!author) return json({ error: "name required" }, 400);

  try {
    const c = addComment(page, input, author, "share");
    try {
      notifyOwner(page, c);
    } catch {
      // the notice is best-effort; the comment is already saved
    }
    return json({ comment: publicComment(c) });
  } catch (e) {
    if (e instanceof CommentError) return json({ error: e.message }, e.status);
    throw e;
  }
}
