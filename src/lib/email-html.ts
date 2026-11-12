// Hand-written allowlist sanitizer for received email HTML. Pure string code, no Node imports.
// Every tag is rebuilt from scratch from an allowlist (nothing is passed through), and the result is
// only ever shown inside a sandboxed iframe (no allow-scripts / allow-same-origin) with a CSP.

const MAX_INPUT = 500_000;

const ALLOWED_TAGS = new Set(
  (
    "a abbr b blockquote br caption center code col colgroup dd div dl dt em font h1 h2 h3 h4 h5 h6 hr i img li ol p pre " +
    "s small span strike strong sub sup table tbody td tfoot th thead tr u ul"
  ).split(" ")
);
const VOID_TAGS = new Set(["br", "hr", "img", "col"]);
// Dropped together with everything between the open and close tag.
const DROP_WITH_CONTENT = new Set(
  (
    "script style iframe object embed applet form input button select textarea svg math noscript template title head " +
    "meta link base video audio source canvas"
  ).split(" ")
);
// Of those, tags that never have content / a closing tag.
const DROP_VOID = new Set(["meta", "link", "base", "input", "source"]);

const GLOBAL_ATTRS = new Set([
  "style", "align", "valign", "width", "height", "bgcolor", "color", "dir", "colspan", "rowspan",
  "cellpadding", "cellspacing", "border", "title",
]);

const ALLOWED_PROPS = new Set([
  "color", "background-color", "font-family", "font-size", "font-weight", "font-style", "text-align",
  "text-decoration", "line-height", "letter-spacing", "width", "max-width", "min-width", "height",
  "vertical-align", "display", "white-space", "list-style-type", "border-collapse", "border-spacing",
]);
const ALLOWED_PROP_PREFIXES = ["padding", "margin", "border"];
const ALLOWED_DISPLAY = /^(block|inline|inline-block|table|table-[a-z-]+|none)$/;
const BAD_CSS = /url\(|expression\(|@import|javascript:|behavior|-moz-binding|\\|\/\*|position|fixed|absolute/i;

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", tab: "\t", newline: "\n", colon: ":",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? all : v;
  });
}

const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function escText(s: string): string {
  return s
    .replace(/&(?!(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeUrl(v: string): string | null {
  const decoded = decodeEntities(v);
  const probe = decoded.replace(/[\u0000- \u007f-\u009f]/g, "");
  if (!/^(https?:|mailto:|tel:)/i.test(probe)) return null;
  return decoded.trim();
}

function filterStyle(v: string): string {
  const out: string[] = [];
  for (const decl of decodeEntities(v).split(";")) {
    const i = decl.indexOf(":");
    if (i < 1) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (!value) continue;
    if (!ALLOWED_PROPS.has(prop) && !ALLOWED_PROP_PREFIXES.some((p) => prop.startsWith(p))) continue;
    if (BAD_CSS.test(value) || BAD_CSS.test(prop)) continue;
    if (prop === "display" && !ALLOWED_DISPLAY.test(value.toLowerCase())) continue;
    out.push(`${prop}:${value}`);
  }
  return out.join(";");
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/y;

export function sanitizeEmailHtml(raw: string): { html: string; hasRemoteImages: boolean } | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const src = raw.length > MAX_INPUT ? raw.slice(0, MAX_INPUT) : raw;
  let out = "";
  let hasRemoteImages = false;
  const stack: string[] = [];
  let pos = 0;

  while (pos < src.length) {
    const lt = src.indexOf("<", pos);
    if (lt === -1) {
      out += escText(src.slice(pos));
      break;
    }
    if (lt > pos) out += escText(src.slice(pos, lt));
    pos = lt;

    if (src.startsWith("<!--", pos)) {
      const end = src.indexOf("-->", pos + 4);
      pos = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", pos)) {
      const end = src.indexOf("]]>", pos + 9);
      pos = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src[pos + 1] === "!" || src[pos + 1] === "?") {
      const end = src.indexOf(">", pos + 2);
      pos = end === -1 ? src.length : end + 1;
      continue;
    }

    TAG_RE.lastIndex = pos;
    const m = TAG_RE.exec(src);
    if (!m) {
      out += "&lt;";
      pos += 1;
      continue;
    }
    pos = TAG_RE.lastIndex;
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();

    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing && !DROP_VOID.has(name)) {
        const re = new RegExp(`<\\/${name}[\\s>]`, "gi");
        re.lastIndex = pos;
        const c = re.exec(src);
        if (!c) {
          pos = src.length;
        } else {
          const end = src.indexOf(">", c.index);
          pos = end === -1 ? src.length : end + 1;
        }
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue;

    if (closing) {
      const idx = stack.lastIndexOf(name);
      if (idx === -1) continue;
      while (stack.length > idx) out += `</${stack.pop()}>`;
      continue;
    }

    const attrs = parseAttrs(m[3]);

    if (name === "img") {
      const w = parseInt(attrs.width ?? "", 10);
      const h = parseInt(attrs.height ?? "", 10);
      if ((Number.isFinite(w) && w <= 1) || (Number.isFinite(h) && h <= 1)) continue;
      const url = decodeEntities(attrs.src ?? "").trim();
      const alt = decodeEntities(attrs.alt ?? "").trim();
      if (/^https?:\/\//i.test(url) && !/[\u0000-\u001f\u007f-\u009f]/.test(url)) {
        hasRemoteImages = true;
        let tag = `<img data-remote-src="${escAttr(url)}" alt="${escAttr(alt)}"`;
        if (attrs.width) tag += ` width="${escAttr(decodeEntities(attrs.width))}"`;
        if (attrs.height) tag += ` height="${escAttr(decodeEntities(attrs.height))}"`;
        out += tag + ">";
      } else if (alt) {
        out += `<span>${escText(alt)}</span>`;
      }
      continue;
    }

    let tag = `<${name}`;
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "style") {
        const s = filterStyle(v);
        if (s) tag += ` style="${escAttr(s)}"`;
      } else if (GLOBAL_ATTRS.has(k)) {
        tag += ` ${k}="${escAttr(decodeEntities(v).trim())}"`;
      } else if (name === "a" && k === "href") {
        const u = safeUrl(v);
        if (u) tag += ` href="${escAttr(u)}"`;
      }
    }
    if (name === "a") tag += ` target="_blank" rel="noopener noreferrer nofollow"`;
    out += tag + ">";
    if (!VOID_TAGS.has(name)) stack.push(name);
  }

  while (stack.length) out += `</${stack.pop()}>`;
  return { html: out, hasRemoteImages };
}

export function emailSrcdoc(sanitizedHtml: string, opts: { loadImages: boolean }): string {
  const imgSrc = opts.loadImages ? "img-src data: https: http:" : "img-src data:";
  const body = opts.loadImages ? sanitizedHtml.replace(/<img data-remote-src=/g, "<img src=") : sanitizedHtml;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; ${imgSrc}">` +
    `<base target="_blank">` +
    `<style>html,body{margin:0;padding:0}body{background:#fff;color:#222;font:14px/1.5 Arial,Helvetica,sans-serif;` +
    `max-width:100%;padding:12px;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:#1a73e8}` +
    `table{max-width:100%}</style></head><body>${body}</body></html>`
  );
}

export function htmlLooksReal(raw: string | undefined | null): boolean {
  if (typeof raw !== "string") return false;
  return /<\s*(table|div|img|a|p|br|ul|ol|li|h[1-6]|blockquote|center|font|span)\b/i.test(raw);
}
