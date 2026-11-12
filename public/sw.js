// GenLimitless OS service worker: page navigations only.
// Network first, always. Only if the network fails (or is slower than 8s AND a saved copy exists) show the
// last good copy of that page, so a network hiccup never shows Safari's "not connected" page.
// Never handles /api, non-GET, sign-in, share/edit links, page files (/_next/static) or other sites.
// To switch it off everywhere: ship this file without the "fetch" listener.
const HTML = "glos-html-v1";
const SKIP = /^\/(api|login|share|edit|c|_glos|_next)(\/|$)/;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || SKIP.test(url.pathname)) return;
  e.respondWith(page(req, url));
});
async function page(req, url) {
  const c = await caches.open(HTML);
  const key = url.origin + url.pathname;
  const net = fetch(req).then((res) => {
    if (res.ok && res.type === "basic" && !res.redirected && (res.headers.get("content-type") || "").includes("text/html")) c.put(key, res.clone()).catch(() => {});
    return res;
  });
  net.catch(() => {});
  const slow = new Promise((resolve) => setTimeout(() => c.match(key).then((hit) => { if (hit) resolve(hit); }), 8000));
  try { return await Promise.race([net, slow]); }
  catch { return (await c.match(key)) || (await c.match(url.origin + "/today")) || reconnecting(); }
}
function reconnecting() {
  return new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>GenLimitless AI OS</title><body style="background:#0a0a0a;color:#ddd;font:16px system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>Reconnecting…</p><script>addEventListener("online",function(){location.reload()});setTimeout(function(){location.reload()},4000)</script>', { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
