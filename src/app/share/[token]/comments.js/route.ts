import { getSharedPage } from "@/lib/pages";
import { CLIENT_JS } from "@/lib/comments-client-src";

export const dynamic = "force-dynamic";

// Bootstrap: no secrets, no per-token data. The token is read from location.pathname.
const BOOT = `
;(function () {
  var m = /^\\/share\\/([A-Za-z0-9_-]{32})/.exec(location.pathname);
  if (!m || !document.body || document.body.getAttribute('data-gl-share') !== '1' || !window.GLComments) return;
  window.GLComments.mount({ root: document.body, api: '/share/' + m[1] + '/comments', mode: 'share' });
})();
`;

const H = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

// Public. Same 404 as the page for invalid, revoked and trashed tokens.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const page = getSharedPage((await params).token);
  if (!page) return new Response("Not found", { status: 404, headers: { ...H, "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(CLIENT_JS + BOOT, { headers: { ...H, "Content-Type": "application/javascript; charset=utf-8" } });
}
