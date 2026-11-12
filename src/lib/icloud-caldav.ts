// Apple/iCloud Calendar over CalDAV (https://caldav.icloud.com). Unlike Google, there's no
// per-account "events" collection URL to guess: it takes principal discovery first (PROPFIND /
// for the Apple ID's principal, then PROPFIND that for calendar-home-set, then PROPFIND the home
// set to list the actual calendar collections — Owner may have more than one, e.g. "Home" and
// "Work"). Auth is HTTP Basic with an app-specific password (a normal Apple ID password is
// rejected for third-party CalDAV clients) — APPLE_ID / APPLE_APP_PASSWORD in .env.local, same
// pattern as the Gmail app-password accounts in mail-accounts.ts.
//
// The iCalendar parsing/RRULE-expansion/escaping helpers are shared with gcal-caldav.ts, see
// caldav-ical.ts. Each discovered calendar is addressed by its display name (e.g. "Home"); that
// name is what flows through as DavEvent.account and the `account` param everywhere below, the
// same way gcal-caldav.ts uses the Gmail address.

import { DavEvent, icalUtc, parseEvents, parseMultistatus, updateIcsBody, veventLines, vtimezoneChicago } from "./caldav-ical";

const DISCOVERY_BASE = "https://caldav.icloud.com";

export class AppleNotConnected extends Error {}

export type { DavEvent };

export function isAppleConfigured(): boolean {
  return !!(process.env.APPLE_ID && process.env.APPLE_APP_PASSWORD);
}

function credsOrThrow() {
  const user = process.env.APPLE_ID;
  const pass = process.env.APPLE_APP_PASSWORD;
  if (!user || !pass) throw new AppleNotConnected("Apple Calendar isn't connected: add APPLE_ID and an app-specific APPLE_APP_PASSWORD to .env.local.");
  return { user, pass: pass.replace(/\s+/g, "") };
}

function authHeader() {
  const { user, pass } = credsOrThrow();
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

/** PROPFIND/REPORT/PUT/DELETE against iCloud, following redirects by hand (iCloud routes every
 *  account to a per-partition host like p03-caldav.icloud.com, and a body-bearing method can't
 *  rely on fetch's automatic redirect handling to preserve the request body). */
async function davFetch(url: string, method: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; headers: Headers }> {
  let target = url;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(target, {
      signal: AbortSignal.timeout(15_000), // never let a slow iCloud hang a page
      method,
      redirect: "manual",
      headers: { Authorization: authHeader(), "Content-Type": "application/xml; charset=utf-8", ...headers },
      body,
    });
    if ([301, 302, 307, 308].includes(res.status) && res.headers.get("location")) {
      target = new URL(res.headers.get("location")!, target).toString();
      continue;
    }
    if (res.status === 401) throw new Error("Apple rejected the app-specific password for iCloud Calendar");
    if (!res.ok && res.status !== 207) throw new Error(`iCloud ${method} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return { status: res.status, text: await res.text(), headers: res.headers };
  }
  throw new Error("Too many redirects talking to iCloud CalDAV");
}

type Discovery = { origin: string; calendars: { href: string; name: string }[] };
let cached: { at: number; discovery: Discovery } | null = null;
const DISCOVERY_TTL_MS = 30 * 60_000;

/** Namespace prefix is optional/any (d:, D:, none for default-namespace XML). */
export function parseHref(xml: string, localName: string): string | undefined {
  const re = new RegExp(`<(?:[\\w-]+:)?${localName}[^>]*>\\s*<(?:[\\w-]+:)?href[^>]*>([^<]+)</(?:[\\w-]+:)?href>`, "i");
  return xml.match(re)?.[1];
}

/** One <response> from a multistatus: href, local names of elements inside <resourcetype>
 *  (e.g. ["collection","calendar"]) and displayname. Prefixes are optional/any and elements may carry
 *  their own xmlns attribute: iCloud sends `<calendar xmlns="urn:ietf:params:xml:ns:caldav"/>`. */
export function parseResponses(xml: string): { href?: string; types: string[]; name?: string }[] {
  return xml
    .split(/<(?:[\w-]+:)?response\b[^>]*>/i)
    .slice(1)
    .map((block) => {
      const href = block.match(/<(?:[\w-]+:)?href\b[^>]*>\s*([^<]+?)\s*<\/(?:[\w-]+:)?href>/i)?.[1];
      const rt = block.match(/<(?:[\w-]+:)?resourcetype\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?resourcetype>/i)?.[1] ?? "";
      const types = [...rt.matchAll(/<(?:[\w-]+:)?([\w-]+)(?=[\s/>])/g)].map((m) => m[1].toLowerCase());
      const name = block.match(/<(?:[\w-]+:)?displayname\b[^>]*>([^<]*)<\/(?:[\w-]+:)?displayname>/i)?.[1]?.trim();
      return { href, types, name };
    });
}

export function parseCalendarList(xml: string, base: string): { href: string; name: string }[] {
  const out: { href: string; name: string }[] = [];
  for (const r of parseResponses(xml)) {
    // only calendar collections: not the home set itself, nor the scheduling inbox/outbox
    if (!r.href || !r.types.includes("calendar") || r.types.includes("schedule-inbox") || r.types.includes("schedule-outbox")) continue;
    out.push({ href: new URL(r.href, base).toString(), name: r.name || decodeURIComponent(r.href.replace(/\/$/, "").split("/").pop() || r.href) });
  }
  return out;
}

/** Diagnostic for a failed listing: number of <response> entries, each href + resourcetype, and the raw body start. */
export function describeListing(r: { status: number; text: string }): string {
  const resp = parseResponses(r.text);
  const seen = resp.map((x) => `${x.href ?? "(no href)"} [${x.types.join(",") || "no resourcetype"}]${x.name ? ` "${x.name}"` : ""}`).join("; ");
  return `HTTP ${r.status}, ${resp.length} <response> entries: ${seen.slice(0, 1500) || "none"}; body (${r.text.length} chars) starts: ${r.text.slice(0, 600)}`;
}

/** Principal → calendar-home-set → calendar collections. Cached for DISCOVERY_TTL_MS so listing
 *  events doesn't re-walk this chain on every call. */
async function discover(): Promise<Discovery> {
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.discovery;
  credsOrThrow();

  const principalRes = await davFetch(
    `${DISCOVERY_BASE}/`,
    "PROPFIND",
    `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
    { Depth: "0" }
  );
  const diag = (r: { status: number; text: string }) => `HTTP ${r.status}, body starts: ${r.text.slice(0, 200)}`;
  const principalHref = parseHref(principalRes.text, "current-user-principal");
  if (!principalHref) throw new Error(`Couldn't discover the Apple ID's principal (${diag(principalRes)})`);
  const principalUrl = new URL(principalHref, DISCOVERY_BASE).toString();

  const homeRes = await davFetch(
    principalUrl,
    "PROPFIND",
    `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`,
    { Depth: "0" }
  );
  const homeHref = parseHref(homeRes.text, "calendar-home-set");
  if (!homeHref) throw new Error(`Couldn't discover Owner's iCloud calendar-home-set (${diag(homeRes)})`);
  const homeUrl = new URL(homeHref, principalUrl).toString();
  const origin = new URL(homeUrl).origin;

  const listRes = await davFetch(
    homeUrl,
    "PROPFIND",
    `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`,
    { Depth: "1" }
  );
  const calendars = parseCalendarList(listRes.text, homeUrl);
  if (!calendars.length) throw new Error(`No calendars found in Owner's iCloud account (${describeListing(listRes)})`);

  const discovery = { origin, calendars };
  cached = { at: Date.now(), discovery };
  return discovery;
}

/** Force a fresh discovery pass (the "Connect Apple Calendar" test button in Analytics). */
export async function icloudTestConnection(): Promise<{ ok: true; calendars: string[] }> {
  cached = null;
  const { calendars } = await discover();
  return { ok: true, calendars: calendars.map((c) => c.name) };
}

export async function icloudCalendarNames(): Promise<string[]> {
  const { calendars } = await discover();
  return calendars.map((c) => c.name);
}

/** Like icloudCalendarNames but reports why discovery failed instead of throwing. */
export async function icloudCalendarNamesOrError(): Promise<{ names: string[]; error?: string }> {
  try {
    return { names: await icloudCalendarNames() };
  } catch (e) {
    return { names: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function calendarByName(name?: string): Promise<{ href: string; name: string }> {
  const { calendars } = await discover();
  if (!name) return calendars[0];
  const found = calendars.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`No iCloud calendar named "${name}" (available: ${calendars.map((c) => c.name).join(", ")})`);
  return found;
}

const absoluteFor = (href: string, origin: string) => (href.startsWith("http") ? href : `${origin}${href}`);

export async function icloudListEvents(calendarName: string | undefined, timeMin: string, timeMax: string): Promise<DavEvent[]> {
  const { calendars } = await discover();
  const targets = calendarName ? [await calendarByName(calendarName)] : calendars;
  const s = icalUtc(timeMin);
  const e = icalUtc(timeMax);
  const lo = new Date(timeMin).getTime();
  const hi = new Date(timeMax).getTime();
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data><c:expand start="${s}" end="${e}"/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${s}" end="${e}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
  const perCalendar = await Promise.all(
    targets.map(async (cal) => {
      const res = await davFetch(cal.href, "REPORT", body, { Depth: "1" });
      return parseMultistatus(res.text).flatMap((r) => parseEvents(r.data, r.href, cal.name, lo, hi));
    })
  );
  return perCalendar
    .flat()
    .filter((ev) => ev.status !== "cancelled")
    .sort((a, b) => a.start.localeCompare(b.start));
}

export async function icloudGetEvent(account: string, href: string): Promise<DavEvent> {
  const { origin } = await discover();
  const res = await davFetch(absoluteFor(href, origin), "GET");
  const [ev] = parseEvents(res.text, href, account);
  if (!ev) throw new Error("Event not found");
  return ev;
}

export async function icloudCreateEvent(
  calendarName: string | undefined,
  opts: { summary: string; start: string; end: string; description?: string; status?: string; attendees?: string[]; recurrence?: string }
): Promise<DavEvent> {
  const cal = await calendarByName(calendarName);
  const { user } = credsOrThrow();
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@genlimitless-os`;
  const href = `${cal.href}${encodeURIComponent(uid)}.ics`;
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//GenLimitless OS//EN", ...(opts.recurrence ? vtimezoneChicago() : []), ...veventLines({ ...opts, uid, organizer: user }), "END:VCALENDAR", ""].join("\r\n");
  await davFetch(href, "PUT", ics, { "If-None-Match": "*", "Content-Type": "text/calendar; charset=utf-8" });
  return icloudGetEvent(cal.name, href);
}

/** Edit an existing event in place, keeping everything we don't touch (alarms, conferencing, etc.). */
export async function icloudUpdateEvent(
  account: string,
  href: string,
  change: { summary?: string; start?: string; end?: string; description?: string; status?: string; attendees?: string[]; recurrence?: string; allowRuleChange?: boolean }
): Promise<DavEvent> {
  const { origin } = await discover();
  const { user } = credsOrThrow();
  const absHref = absoluteFor(href, origin);
  const getRes = await davFetch(absHref, "GET");
  const updated = updateIcsBody(getRes.text, { ...change, organizer: user });
  const etag = getRes.headers.get("etag") || "";
  await davFetch(absHref, "PUT", updated, { "Content-Type": "text/calendar; charset=utf-8", ...(etag ? { "If-Match": etag } : {}) });
  return icloudGetEvent(account, href);
}

export async function icloudCancelEvent(account: string, href: string) {
  const { origin } = await discover();
  await davFetch(absoluteFor(href, origin), "DELETE");
  return { cancelled: true, id: href, account };
}
