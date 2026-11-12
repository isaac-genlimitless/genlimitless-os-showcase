import {
  EditError,
  LIMITS,
  applyEditorChange,
  badTokenLimit,
  csrfFor,
  csrfOk,
  currentMarkdown,
  lastEdit,
  readLimit,
  resolveEdit,
  writeLimit,
} from "@/lib/page-edit-access";
import { clientIp, originOk } from "@/lib/file-comments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string; asset?: string[] }> };

const SEC = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const text = (body: string, status: number, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...SEC, "Content-Type": "text/plain; charset=utf-8", ...extra } });
const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...SEC, "Content-Type": "application/json; charset=utf-8", ...extra } });
const notFound = () => text("Not found", 404);

/** Single gate: invalid tokens are rate limited per IP and always give the same 404. */
function gate(token: string, ip: string): { r: NonNullable<ReturnType<typeof resolveEdit>> } | { res: Response } {
  const r = resolveEdit(token);
  if (!r) {
    const wait = badTokenLimit(ip);
    return { res: wait ? text("Too many requests", 429, { "Retry-After": String(wait) }) : notFound() };
  }
  return { r };
}

const EDITOR_JS = `(function () {
  var parts = location.pathname.split("/");
  var base = "/" + parts[1] + "/" + parts[2];
  var ta = document.getElementById("gl-text");
  var nm = document.getElementById("gl-name");
  var btn = document.getElementById("gl-save");
  var msg = document.getElementById("gl-msg");
  var last = document.getElementById("gl-last");
  var state = { body: "", updated_at: "", csrf: "" };
  try { nm.value = localStorage.getItem("gl_edit_name") || ""; } catch (e) {}
  function say(t) { msg.textContent = t; }
  function showLast(l) { last.textContent = l ? "Last edited " + l.created_at + " UTC by " + l.editor : "Not edited yet"; }
  function load() {
    return fetch(base + "/doc", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("This edit link is no longer active.");
      return r.json();
    }).then(function (d) {
      ta.value = d.body;
      state.body = ta.value;
      state.updated_at = d.updated_at;
      state.csrf = d.csrf;
      showLast(d.last_edit);
      btn.disabled = false;
    });
  }
  function diff(a, b) {
    var max = Math.min(a.length, b.length), p = 0;
    while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    if (p > 0 && a.charCodeAt(p - 1) >= 0xd800 && a.charCodeAt(p - 1) <= 0xdbff) p--;
    var s = 0;
    while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
    if (s > 0 && a.charCodeAt(a.length - s) >= 0xdc00 && a.charCodeAt(a.length - s) <= 0xdfff) s--;
    return { start: p, end: a.length - s, expected: a.slice(p, a.length - s), replacement: b.slice(p, b.length - s) };
  }
  btn.addEventListener("click", function () {
    var d = diff(state.body, ta.value);
    if (d.expected === d.replacement) { say("No changes to save."); return; }
    btn.disabled = true;
    var name = nm.value;
    try { localStorage.setItem("gl_edit_name", name); } catch (e) {}
    fetch(base + "/doc", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Edit-CSRF": state.csrf },
      body: JSON.stringify({ base_updated_at: state.updated_at, start: d.start, end: d.end, expected: d.expected, replacement: d.replacement, editor: name })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; });
    }).then(function (x) {
      if (x.status === 409) { return load().then(function () { say("Someone else changed this page. The latest text is loaded; please redo your change."); }); }
      if (x.status === 429) { btn.disabled = false; say("Too many saves. Please wait a moment."); return; }
      if (x.status >= 400) { btn.disabled = false; say(x.j.error || "Could not save."); return; }
      return load().then(function () { say("Saved."); });
    }).catch(function (e) { btn.disabled = false; say(String(e.message || e)); });
  });
  btn.disabled = true;
  load().catch(function (e) { say(String(e.message || e)); });
})();
`;

function shell(token: string, title: string, last: { editor: string; created_at: string } | null): string {
  const lastLine = last ? `Last edited ${esc(last.created_at)} UTC by ${esc(last.editor)}` : "Not edited yet";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Edit: ${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:0 auto;padding:24px 16px 64px;color:#111}textarea{width:100%;min-height:60vh;box-sizing:border-box;font:14px/1.5 ui-monospace,monospace;padding:10px}input{padding:6px;margin-right:8px}button{padding:6px 14px}.m{color:#555;font-size:13px}</style></head>
<body><h1>${esc(title)}</h1><p class="m" id="gl-last">${lastLine}</p>
<textarea id="gl-text" aria-label="Page text" spellcheck="true"></textarea>
<p><input id="gl-name" maxlength="60" placeholder="Your name" aria-label="Your name"><button id="gl-save" type="button">Save</button></p>
<p class="m" id="gl-msg" role="status"></p>
<p class="m">Every save is logged with your name and can be reverted by the page owner. You can only change the text of this page.</p>
<script src="/edit/${token}/editor.js" defer></script></body></html>`;
}

export async function GET(req: Request, { params }: Ctx) {
  const { token, asset } = await params;
  const ip = clientIp(req);
  const g = gate(token, ip);
  if ("res" in g) return g.res;
  const { page, access } = g.r;
  const wait = readLimit(access, ip);
  if (wait) return text("Too many requests", 429, { "Retry-After": String(wait) });
  const sub = asset && asset.length ? asset.join("/") : "";
  if (sub === "") {
    return new Response(shell(token, page.title, lastEdit(page.id)), {
      headers: { ...SEC, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP },
    });
  }
  if (sub === "editor.js") {
    return new Response(EDITOR_JS, { headers: { ...SEC, "Content-Type": "text/javascript; charset=utf-8" } });
  }
  if (sub === "doc") {
    return json({
      title: page.title,
      body: await currentMarkdown(page),
      updated_at: page.updated_at,
      last_edit: lastEdit(page.id),
      csrf: csrfFor(access),
    });
  }
  return notFound();
}

export async function HEAD(req: Request, ctx: Ctx) {
  return GET(req, ctx);
}

export async function POST(req: Request, { params }: Ctx) {
  const { token, asset } = await params;
  const ip = clientIp(req);
  const g = gate(token, ip);
  if ("res" in g) return g.res;
  if (!asset || asset.length !== 1 || asset[0] !== "doc") return notFound();
  const { access } = g.r;
  if (!originOk(req)) return json({ error: "forbidden" }, 403);
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (!ct.startsWith("application/json")) return json({ error: "Content-Type must be application/json" }, 415);
  if (!csrfOk(access, req.headers.get("x-edit-csrf"))) return json({ error: "forbidden" }, 403);
  const wait = writeLimit(access, ip);
  if (wait) return json({ error: "Too many saves, slow down" }, 429, { "Retry-After": String(wait) });
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > LIMITS.request) return json({ error: "Request too large" }, 413);
  const raw = await req.text();
  if (Buffer.byteLength(raw) > LIMITS.request) return json({ error: "Request too large" }, 413);
  let input: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad");
    input = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  try {
    const out = await applyEditorChange(
      token,
      {
        base_updated_at: input.base_updated_at,
        start: input.start,
        end: input.end,
        expected: input.expected,
        replacement: input.replacement,
        editor: input.editor,
      },
      ip
    );
    return json({ ok: true, changed: out.changed, updated_at: out.page.updated_at });
  } catch (e) {
    if (e instanceof EditError) {
      if (e.status === 404) return notFound();
      return json({ error: e.message, ...(e.extra || {}) }, e.status);
    }
    return json({ error: "Could not save" }, 500);
  }
}
