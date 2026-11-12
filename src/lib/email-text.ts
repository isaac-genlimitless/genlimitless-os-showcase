import { convert } from "html-to-text";

// Turns whatever an email's body is into clean, readable plain text.
//
// Why this exists: some senders (Robinhood, lots of marketing tools) put an entire HTML page
// inside the "text/plain" part, and mail parsers trust the label, so the OS showed raw
// `<!doctype html>...` source. Marketing HTML also carries invisible pre-header padding and
// enormous tracking links. Everything the OS shows or hands to an agent goes through here.

const INVISIBLE = /[­͏​-‏⁠﻿᠎]/g;

/** Does this "text" look like HTML source rather than a written message? */
export function looksLikeHtml(s: string | null | undefined): boolean {
  if (!s) return false;
  const head = s.trim().slice(0, 3000);
  if (/^<(!doctype|html|head|body|table|div|meta|style|center|span|p)[\s>]/i.test(head)) return true;
  return (head.match(/<\/?[a-z][a-z0-9-]*(\s[^<>]*)?>/gi) || []).length >= 8;
}

function tidy(s: string): string {
  return s
    .replace(INVISIBLE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToPlain(html: string): string {
  const text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" }, // tracking pixels and banners
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "a", options: { hideLinkHrefIfSameAsText: true, linkBrackets: ["(", ")"] } },
      { selector: "table", format: "dataTable", options: { uppercaseHeaderCells: false } },
      // Keep headings in their original case (the library shouts them in capitals by default).
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, options: { uppercase: false } })),
    ],
  });
  // Marketing links carry 200+ character tracking URLs: they only add noise here.
  return tidy(text.replace(/\s*\(https?:\/\/[^)\s]{90,}\)/g, "").replace(/https?:\/\/\S{90,}/g, "(link)"));
}

export const BODY_HARD_CAP = 40_000;

/** Full body for agents: untouched unless it exceeds the hard cap, in which case truncated=true. */
export function capBody(text: string | null | undefined, cap = BODY_HARD_CAP): { text: string; chars: number; truncated: boolean } {
  const t = text || "";
  return t.length > cap
    ? { text: t.slice(0, cap) + `\n[TRUNCATED: body is ${t.length} characters, showing the first ${cap}]`, chars: t.length, truncated: true }
    : { text: t, chars: t.length, truncated: false };
}

/** Pulls the actual message out of a LinkedIn notification email. Null for non-LinkedIn senders. */
export function extractLinkedInMessage(
  text: string,
  from: string
): { sender?: string; message?: string; teaser_only: boolean } | null {
  if (!/linkedin\.com/i.test(from || "")) return null;
  let lines = (text || "").split(/\r?\n/).map((l) => l.trim());
  const footer = lines.findIndex((l) => /^(unsubscribe|you are receiving|help center|linkedin corporation)/i.test(l));
  if (footer >= 0) lines = lines.slice(0, footer);
  const isPrompt = (l: string) => /^\(?\s*(view|see)\s+(the\s+)?message\s*\)?$/i.test(l) || /^reply\b/i.test(l) || /^\[?(view|see) message\]?\s*\(?https?:/i.test(l);
  const hadPrompt = lines.some(isPrompt);
  lines = lines.filter((l) => !isPrompt(l));
  const nameMatch = from.match(/^"?([^"<]+?)"?\s*</);
  let sender = nameMatch ? nameMatch[1].trim() : undefined;
  const nonEmpty = lines.filter(Boolean);
  let idx = -1;
  if (sender) idx = lines.findIndex((l) => l && l.toLowerCase().includes(sender!.toLowerCase()));
  if (idx < 0 && nonEmpty.length > 1) {
    idx = lines.indexOf(nonEmpty[0]);
    sender = sender || nonEmpty[0];
  }
  const rest = idx >= 0 ? lines.slice(idx + 1) : lines;
  const message = rest.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const teaser_only = (!message && hadPrompt) || message.length < 40 || /(…|\.\.\.)$/.test(message);
  return { sender, message: message || undefined, teaser_only };
}

/** Best readable text for a message, given its plain part and (optionally) its HTML part. */
export function bestPlainText(text?: string | null, html?: string | false | null): string {
  if (text && !looksLikeHtml(text)) {
    const plain = tidy(text);
    if (typeof html === "string" && html) {
      const fromHtml = htmlToPlain(html);
      if (fromHtml.length > 200 && fromHtml.length > plain.length * 2) return fromHtml;
    }
    return plain;
  }
  const source = typeof html === "string" && html ? html : text || "";
  if (!source) return "";
  return looksLikeHtml(source) ? htmlToPlain(source) : tidy(source);
}
