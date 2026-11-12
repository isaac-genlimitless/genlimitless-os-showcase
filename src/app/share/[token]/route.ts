import { getSharedPage } from "@/lib/pages";
import { renderSharedHtml } from "@/lib/share";

export const dynamic = "force-dynamic";

const SEC = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

// Public, read-only. Invalid, revoked and trashed tokens all give the same 404.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token;
  const page = getSharedPage(token);
  if (!page) return new Response("Not found", { status: 404, headers: { ...SEC, "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(await renderSharedHtml(page), {
    headers: {
      ...SEC,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
