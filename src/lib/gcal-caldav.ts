import { listAccounts, legacyImapCreds } from "./mail-accounts";
import { DavEvent, icalUtc, parseEvents, parseMultistatus, unfold, updateIcsBody, veventLines, vtimezoneChicago } from "./caldav-ical";

// Google Calendar over CalDAV, authenticated with the same Gmail app passwords the OS already
// uses for IMAP/SMTP. No Google Cloud OAuth client needed. gcal.ts uses this for any account
// that hasn't been connected through OAuth. The iCalendar parsing/RRULE-expansion/escaping
// helpers live in caldav-ical.ts, shared with icloud-caldav.ts.
//
// Event ids here are the event's CalDAV resource path (e.g. /calendar/dav/me%40x.com/events/abc.ics).

export type { DavEvent };

const BASE = "https://www.google.com/calendar/dav";

/** Accounts connected with an app password (the ones CalDAV can use). */
export function davAccounts(): string[] {
  return listAccounts()
    .filter((a) => a.kind === "legacy_app_password" && a.status === "connected")
    .map((a) => a.email.toLowerCase());
}

function authHeader(account: string) {
  const { user, pass } = legacyImapCreds(account);
  return "Basic " + Buffer.from(`${user}:${pass.replace(/\s+/g, "")}`).toString("base64");
}

const collection = (account: string) => `${BASE}/${encodeURIComponent(account)}/events/`;
const absolute = (href: string) => (href.startsWith("http") ? href : `https://www.google.com${href}`);

async function dav(account: string, url: string, init: { method: string; body?: string; headers?: Record<string, string> }) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000), // never let a slow Google CalDAV hang a page
    method: init.method,
    body: init.body,
    headers: { Authorization: authHeader(account), "Content-Type": "text/calendar; charset=utf-8", ...(init.headers || {}) },
  });
  if (res.status === 401) throw new Error(`Google rejected the app password for ${account}'s calendar`);
  if (!res.ok && res.status !== 207) throw new Error(`CalDAV ${init.method} failed for ${account}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

export async function davListEvents(account: string, timeMin: string, timeMax: string): Promise<DavEvent[]> {
  const s = icalUtc(timeMin);
  const e = icalUtc(timeMax);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data><c:expand start="${s}" end="${e}"/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${s}" end="${e}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
  const res = await dav(account, collection(account), { method: "REPORT", body, headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" } });
  const lo = new Date(timeMin).getTime();
  const hi = new Date(timeMax).getTime();
  return parseMultistatus(await res.text())
    .flatMap((r) => parseEvents(r.data, r.href, account, lo, hi))
    .filter((ev) => ev.status !== "cancelled")
    .sort((a, b) => a.start.localeCompare(b.start));
}

async function fetchResource(account: string, href: string): Promise<{ ics: string; etag: string }> {
  const res = await dav(account, absolute(href), { method: "GET" });
  return { ics: await res.text(), etag: res.headers.get("etag") || "" };
}

export async function davGetEvent(account: string, href: string): Promise<DavEvent> {
  const { ics } = await fetchResource(account, href);
  const [ev] = parseEvents(ics, href, account);
  if (!ev) throw new Error("Event not found");
  return ev;
}

export async function davCreateEvent(
  account: string,
  opts: { summary: string; start: string; end: string; description?: string; status?: string; attendees?: string[]; recurrence?: string }
): Promise<DavEvent> {
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@genlimitless-os`;
  const href = `${collection(account)}${encodeURIComponent(uid)}.ics`;
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//GenLimitless OS//EN", ...(opts.recurrence ? vtimezoneChicago() : []), ...veventLines({ ...opts, uid, organizer: account }), "END:VCALENDAR", ""].join("\r\n");
  await dav(account, href, { method: "PUT", body: ics, headers: { "If-None-Match": "*" } });
  return davGetEvent(account, new URL(href).pathname);
}

/** Edit an existing event in place, keeping everything we don't touch (alarms, conferencing, etc.). */
export async function davUpdateEvent(
  account: string,
  href: string,
  change: { summary?: string; start?: string; end?: string; description?: string; status?: string; attendees?: string[]; recurrence?: string; allowRuleChange?: boolean }
): Promise<DavEvent> {
  const { ics, etag } = await fetchResource(account, href);
  const updated = updateIcsBody(ics, { ...change, organizer: account });
  await dav(account, absolute(href), { method: "PUT", body: updated, headers: etag ? { "If-Match": etag } : {} });
  return davGetEvent(account, href);
}

export async function davCancelEvent(account: string, href: string) {
  await dav(account, absolute(href), { method: "DELETE" });
  return { cancelled: true, id: href, account };
}
