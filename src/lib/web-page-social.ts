// Read-only reader for PUBLIC LinkedIn people, company and post pages. No login, no cookies, no
// credentials: it only extracts what LinkedIn serves logged-out for SEO (og tags + JSON-LD).
// Safety is inherited from read_web_page: GET only, assertPublicHost at every hop, manual redirects.
import { convert } from "html-to-text";

export type SocialDeps = {
  assertPublicHost: (host: string) => Promise<void>;
  fetchPage: (url: string, init: RequestInit) => Promise<Response>;
  headers: Record<string, string>;
  paged: (text: string, offset: number, url: string, title: string, note?: string) => unknown;
  /** One-shot headless-browser read (readWebPageRendered). */
  render: (input: { url: string; offset?: number }) => Promise<unknown>;
};

const MAX_BYTES = 2_000_000;
const SLUG = /^[A-Za-z0-9%_.\-]{1,200}$/;

function isLinkedInHost(host: string) {
  const h = host.toLowerCase();
  return h === "linkedin.com" || h.endsWith(".linkedin.com");
}

/** Rebuild a clean URL from validated parts, or null if it isn't a public LinkedIn people/company/post page. */
export function rebuildLinkedInUrl(u: URL): string | null {
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!isLinkedInHost(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [kind, slug] = parts;
  let path: string | null = null;
  if (["in", "company", "school", "posts", "pulse"].includes(kind)) {
    if (!SLUG.test(slug) || slug === "." || slug === ".." || slug.includes("..")) return null;
    path = `/${kind}/${slug}`;
  } else if (kind === "feed" && slug === "update" && parts.length >= 3 && /^urn:li:activity:\d{5,25}$/.test(parts[2])) {
    path = `/feed/update/${parts[2]}`;
  }
  if (!path) return null;
  return `https://www.linkedin.com${path}`;
}

export function isLinkedInSocialUrl(u: URL): boolean {
  return rebuildLinkedInUrl(u) !== null;
}

function decodeEntities(s: string) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function meta(html: string, prop: string): string {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  if (!tag) return "";
  return decodeEntities(tag.match(/content=["']([^"']*)["']/i)?.[1] || "").trim();
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

function flatten(node: unknown, out: Record<string, unknown>[]) {
  if (Array.isArray(node)) return node.forEach((n) => flatten(n, out));
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    out.push(o);
    if (Array.isArray(o["@graph"])) flatten(o["@graph"], out);
  }
}

function htmlToPlain(s: string) {
  return /<[a-z][\s\S]*>/i.test(s) ? convert(s, { wordwrap: false }).trim() : s;
}

/** Pull the publicly visible facts out of logged-out LinkedIn HTML. Returns null if nothing useful. */
export function parseLinkedInPublic(html: string): { title: string; text: string } | null {
  const ogTitle = meta(html, "og:title");
  const ogDesc = meta(html, "og:description") || meta(html, "description");
  const lines: string[] = [];
  const nodes: Record<string, unknown>[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      flatten(JSON.parse(m[1]), nodes);
    } catch {
      /* ignore malformed block */
    }
  }
  for (const n of nodes) {
    const type = [n["@type"]].flat().map(String).join(",");
    if (!/Person|Organization|DiscussionForumPosting|Article|SocialMediaPosting|ProfilePage/.test(type)) continue;
    const add = (label: string, v: unknown) => {
      const s = str(v);
      if (s) lines.push(`${label}: ${htmlToPlain(s)}`);
    };
    add("Type", type);
    add("Name", n.name);
    add("Headline", n.headline);
    add("Job title", Array.isArray(n.jobTitle) ? n.jobTitle.map(str).join("; ") : n.jobTitle);
    const works = [n.worksFor].flat().map((w) => (w && typeof w === "object" ? str((w as Record<string, unknown>).name) : str(w))).filter(Boolean);
    if (works.length) lines.push(`Works for: ${works.join("; ")}`);
    const author = n.author && typeof n.author === "object" ? str((n.author as Record<string, unknown>).name) : "";
    add("Author", author);
    add("Description", n.description);
    add("Date published", n.datePublished);
    add("Article body", n.articleBody);
    add("Text", n.text);
    add("Employees", n.numberOfEmployees && typeof n.numberOfEmployees === "object" ? (n.numberOfEmployees as Record<string, unknown>).value : n.numberOfEmployees);
    const stats = [n.interactionStatistic].flat().filter((s) => s && typeof s === "object") as Record<string, unknown>[];
    for (const s of stats) {
      const t = s.interactionType && typeof s.interactionType === "object" ? str((s.interactionType as Record<string, unknown>)["@type"]) : str(s.interactionType);
      const c = str(s.userInteractionCount);
      if (c) lines.push(`${t.replace(/^.*\//, "").replace(/Action$/, "") || "Interactions"}: ${c}`);
    }
    const addr = n.address && typeof n.address === "object" ? (n.address as Record<string, unknown>) : null;
    if (addr) add("Location", [addr.addressLocality, addr.addressRegion, addr.addressCountry].map(str).filter(Boolean).join(", "));
  }
  const parts: string[] = [];
  if (ogTitle) parts.push(`Title: ${ogTitle}`);
  if (ogDesc) parts.push(`Summary: ${ogDesc}`);
  parts.push(...lines);
  if (!ogTitle && !ogDesc && !lines.length) return null;
  // Only a login/authwall shell: its og tags are generic.
  if (/^(sign up|log ?in|linkedin: log in or sign up)/i.test(ogTitle) && !lines.length) return null;
  return { title: ogTitle || lines.find((l) => l.startsWith("Name: "))?.slice(6) || "LinkedIn", text: parts.join("\n") };
}

const LI_NOTE =
  "LinkedIn public view only (no login). Confirm the name matches (slugs collide, e.g. linkedin.com/company/built is a different company). Only what LinkedIn shows logged-out is available.";

function blockedMessage(tried: string) {
  return new Error(
    `LinkedIn would not show this page without logging in (tried: ${tried}). Don't retry. Ask Owner to paste the text of the profile, company page or post.`,
  );
}

async function plainGet(start: string, deps: SocialDeps): Promise<{ blocked: boolean; html: string; finalUrl: string }> {
  let current = new URL(start);
  for (let hop = 0; hop < 4; hop++) {
    await deps.assertPublicHost(current.hostname);
    const res = await deps.fetchPage(current.toString(), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(30_000), headers: deps.headers });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") || "";
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        return { blocked: true, html: "", finalUrl: current.toString() };
      }
      if (/\/(authwall|login|uas\/login|checkpoint)/.test(next.pathname) || !isLinkedInHost(next.hostname) || next.protocol !== "https:") {
        return { blocked: true, html: "", finalUrl: current.toString() };
      }
      current = next;
      continue;
    }
    if ([401, 403, 429, 503, 999].includes(res.status)) return { blocked: true, html: "", finalUrl: current.toString() };
    if (res.status === 404 || res.status === 410) throw new Error("This LinkedIn page was not found (it may be removed or private).");
    if (!res.ok) throw new Error(`The page returned HTTP ${res.status}.`);
    const buf = await res.arrayBuffer();
    const html = new TextDecoder().decode(buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf);
    return { blocked: false, html, finalUrl: current.toString() };
  }
  return { blocked: true, html: "", finalUrl: current.toString() };
}

export async function readLinkedInPublic(url: URL, offset: number | undefined, deps: SocialDeps): Promise<unknown> {
  const clean = rebuildLinkedInUrl(url);
  if (!clean) throw new Error("Not a public LinkedIn profile, company or post URL.");
  const got = await plainGet(clean, deps);
  if (!got.blocked) {
    const parsed = parseLinkedInPublic(got.html);
    if (parsed) return deps.paged(parsed.text, offset || 0, clean, parsed.title, LI_NOTE);
  }
  // Exactly one rendered-browser retry (already host-guarded), never a loop.
  try {
    return await deps.render({ url: clean, offset });
  } catch {
    throw blockedMessage("a plain public request and one headless-browser read");
  }
}
