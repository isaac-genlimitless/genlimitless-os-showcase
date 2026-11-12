// Pure helpers: keep LinkedIn profile links when pasting copied LinkedIn text (links live only in text/html).
export type ProfileLink = { url: string; name: string };

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalise(href: string): string | null {
  let u: URL;
  try {
    u = new URL(decode(href).trim(), "https://www.linkedin.com");
  } catch {
    return null;
  }
  if (!/^(^|.*\.)linkedin\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/in\/([^/]+)/i);
  if (!m) return null;
  return `https://www.linkedin.com/in/${m[1]}`;
}

export function extractProfileLinks(html: string): ProfileLink[] {
  const out: ProfileLink[] = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = normalise(m[1] ?? m[2] ?? "");
    if (!url) continue;
    const text = decode(m[3].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    const good = text !== "" && !/^view\b.*\bprofile\b/i.test(text);
    const existing = out.find((l) => l.url.toLowerCase() === url.toLowerCase());
    if (existing) {
      if (!existing.name && good) existing.name = text;
    } else {
      out.push({ url, name: good ? text : "" });
    }
  }
  return out;
}

export function mergeProfileLinks(plain: string, links: ProfileLink[]): string {
  const lower = plain.toLowerCase();
  const lines = plain.split("\n");
  const used = new Set<number>();
  const after = new Map<number, string[]>();
  const leftover: string[] = [];
  for (const l of links) {
    if (lower.includes(l.url.toLowerCase())) continue;
    const name = l.name.trim().toLowerCase();
    let idx = -1;
    if (name) {
      idx = lines.findIndex((ln, i) => !used.has(i) && ln.trim().toLowerCase() === name);
      if (idx < 0 && name.length >= 3) {
        idx = lines.findIndex(
          (ln, i) => !used.has(i) && ln.length <= 80 && ln.toLowerCase().includes(name),
        );
      }
    }
    if (idx >= 0) {
      used.add(idx);
      after.set(idx, [...(after.get(idx) ?? []), `Profile: ${l.url}`]);
    } else {
      leftover.push(`Profile: ${l.url}`);
    }
  }
  const res: string[] = [];
  lines.forEach((ln, i) => {
    res.push(ln);
    const a = after.get(i);
    if (a) res.push(...a);
  });
  let text = res.join("\n");
  if (leftover.length) text += `\n\n${leftover.join("\n")}`;
  return text;
}

export function buildPasteText(plain: string, html: string): string | null {
  if (!html) return null;
  const links = extractProfileLinks(html);
  if (links.length === 0) return null;
  return mergeProfileLinks(plain, links);
}
