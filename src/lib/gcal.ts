import fs from "fs";
import path from "path";

// Google Calendar integration (OAuth, full calendar read/write scope — Owner wants the agent
// to be able to create events, not just read them). Mirrors gdrive.ts/gmail.ts's OAuth shape,
// but keeps its own token file (separate from Drive's and Gmail's) so connecting one never
// implies the others are connected. Supports more than one connected Google account, keyed by
// email, since Owner's real schedule can live on either owner@example.com or his personal
// Gmail — see connectedCalendarAccounts / the account param on every function below.
//
// Accounts without an OAuth token (the usual case: Gmail connected with an app password) are
// reached over CalDAV with that same app password instead (gcal-caldav.ts), so the calendar
// works with no Google Cloud setup at all.

import { DATA_DIR } from "./data-dir";
import { assertStartMatchesRule, normalizeRecurrence } from "./caldav-ical";
import { DavEvent, davAccounts, davCancelEvent, davCreateEvent, davGetEvent, davListEvents, davUpdateEvent } from "./gcal-caldav";
import { icloudCalendarNames, icloudCancelEvent, icloudCreateEvent, icloudGetEvent, icloudListEvents, icloudUpdateEvent, isAppleConfigured } from "./icloud-caldav";
const TOKEN_FILE = path.join(DATA_DIR, "google-calendar-token.json");
const API = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

const CHICAGO_TZ = "America/Chicago";

export class CalendarNotConnected extends Error {}

type TokenStore = Record<string, { refresh_token: string }>;

function clientCreds() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret)
    throw new CalendarNotConnected(
      "Google Calendar isn't set up: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing from .env.local."
    );
  return { id, secret };
}

function redirectUri(origin: string) {
  return `${origin}/api/google/callback`;
}

// state: "calendar" tells /api/google/callback which flow this is, the same way gmail.ts's
// "gmail:<label>" state does — no state (or anything else) means the original Drive flow.
export function authUrl(origin: string) {
  const { id } = clientCreds();
  const p = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: CALENDAR_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state: "calendar",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

function readStore(): TokenStore {
  if (!fs.existsSync(TOKEN_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeStore(store: TokenStore) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** Exchange an auth code for tokens and store them keyed by whichever Google account granted
 *  consent (found via the connected account's own calendar, not a separate identity scope). */
export async function exchangeCode(code: string, origin: string) {
  const { id, secret } = clientCreds();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: id,
      client_secret: secret,
      redirect_uri: redirectUri(origin),
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) throw new Error(`Google Calendar token exchange failed: ${JSON.stringify(data)}`);

  const cal = await fetch(`${API}/users/me/calendarList/primary`, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  }).then((r) => r.json());
  const email = cal.id as string | undefined;
  if (!email) throw new Error("Couldn't read the connected account's email from the calendar response");

  const store = readStore();
  store[email.toLowerCase()] = { refresh_token: data.refresh_token };
  writeStore(store);
  return { email };
}

/** Accounts connected through the OAuth flow (Google Calendar API). */
function oauthAccounts(): string[] {
  return process.env.GOOGLE_CLIENT_ID ? Object.keys(readStore()) : [];
}
const viaOAuth = (email: string) => oauthAccounts().includes(email.toLowerCase());

// Apple calendars are addressed as "apple:<calendar name>" (e.g. "apple:Home") everywhere an
// account string flows through this file, so a caller can tell a Google email and an iCloud
// calendar apart at a glance without a separate parameter.
const APPLE_PREFIX = "apple:";
const isApple = (account: string) => account.toLowerCase().startsWith(APPLE_PREFIX);
const appleCalendarName = (account: string) => account.slice(APPLE_PREFIX.length);

/** Every iCloud calendar, prefixed "apple:". Best-effort: a discovery failure (bad creds, iCloud
 *  briefly down) degrades to "no Apple calendars this call" rather than breaking Google calendar
 *  access, same as an unset APPLE_ID/APPLE_APP_PASSWORD. */
async function appleAccounts(): Promise<string[]> {
  if (!isAppleConfigured()) return [];
  try {
    return (await icloudCalendarNames()).map((n) => `${APPLE_PREFIX}${n}`);
  } catch {
    return [];
  }
}

export async function isCalendarConnected(): Promise<boolean> {
  return (await connectedCalendarAccounts()).length > 0;
}

/** Every account whose calendar the OS can use: OAuth-connected Google accounts, every Gmail
 *  account connected with an app password (gcal-caldav.ts), and every calendar in Owner's
 *  iCloud account once APPLE_ID/APPLE_APP_PASSWORD are set (icloud-caldav.ts). */
export async function connectedCalendarAccounts(): Promise<string[]> {
  const google = [...new Set([...oauthAccounts(), ...davAccounts()])];
  return [...google, ...(await appleAccounts())];
}

// Calendar requests give up after this long, so a slow Google or iCloud never hangs a page.
export const CALENDAR_TIMEOUT_MS = 15_000;

// Access tokens last about an hour; reuse them instead of asking Google for a new one on every
// calendar request (that was an extra round-trip per account on every Today/Calendar load).
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(email: string): Promise<string> {
  const key = email.toLowerCase();
  const store = readStore();
  const entry = store[key];
  if (!entry) throw new CalendarNotConnected(`Calendar isn't connected for ${email} — connect it in Settings.`);
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token; // only while the account is still connected
  const { id, secret } = clientCreds();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    signal: AbortSignal.timeout(CALENDAR_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: entry.refresh_token,
      client_id: id,
      client_secret: secret,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error === "invalid_grant") {
      delete store[email.toLowerCase()];
      writeStore(store);
    }
    throw new CalendarNotConnected(`Google Calendar access for ${email} was revoked or expired (${data.error}) — reconnect in Settings.`);
  }
  // Refresh a minute early so a cached token never expires mid-request.
  const ttlMs = (Number(data.expires_in) || 3600) * 1000 - 60_000;
  if (ttlMs > 0) tokenCache.set(key, { token: data.access_token, expiresAt: Date.now() + ttlMs });
  return data.access_token;
}

async function allConnectedOrThrow(): Promise<string[]> {
  const accounts = await connectedCalendarAccounts();
  if (accounts.length === 0)
    throw new CalendarNotConnected("No calendar available: no Gmail or Apple account is connected (Settings → connect a calendar).");
  return accounts;
}

/** One account if given (Apple accounts are trusted here and validated where they're actually
 *  used, since confirming one exists means re-discovering the whole iCloud calendar list;
 *  Google accounts are checked against what's actually connected), otherwise every connected
 *  account. */
async function resolveAccounts(account?: string): Promise<string[]> {
  if (!account) return allConnectedOrThrow();
  if (isApple(account)) {
    if (!isAppleConfigured()) throw new CalendarNotConnected("Apple Calendar isn't connected — add APPLE_ID/APPLE_APP_PASSWORD in .env.local.");
    return [account];
  }
  if (!(await connectedCalendarAccounts()).some((e) => e.toLowerCase() === account.toLowerCase()))
    throw new CalendarNotConnected(`Calendar isn't connected for ${account} — connect it in Settings.`);
  return [account.toLowerCase()];
}

/** Owner's business account if it's connected, else whichever connected account comes first. */
async function preferredAccount(): Promise<string> {
  const accounts = await allConnectedOrThrow();
  return accounts.find((e) => e.toLowerCase() === "owner@example.com") || accounts[0];
}

async function api(email: string, urlPath: string, init: RequestInit = {}) {
  const token = await accessToken(email);
  const res = await fetch(`${API}${urlPath}`, {
    signal: AbortSignal.timeout(CALENDAR_TIMEOUT_MS),
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (res.status === 401) tokenCache.delete(email.toLowerCase()); // revoked early: fetch a fresh one next time
  if (!res.ok) throw new Error(`Google Calendar API ${urlPath} failed: ${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

export type CalendarEvent = {
  id: string;
  account: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  attendees: string[];
  status: string;
  htmlLink: string;
  allDay?: boolean;
  recurring?: boolean;
  recurrence?: string;
};

function fromDav(e: DavEvent, account: string = e.account): CalendarEvent {
  return {
    id: e.id,
    account,
    summary: e.summary,
    description: e.description,
    start: e.start,
    end: e.end,
    attendees: e.attendees,
    status: e.status,
    htmlLink: e.htmlLink,
    allDay: e.allDay,
    recurring: e.recurring,
    recurrence: e.recurrence,
  };
}

export function toCalendarEvent(data: any, account: string): CalendarEvent {
  const rrule = ((data.recurrence || []) as string[]).find((r) => typeof r === "string" && r.startsWith("RRULE:"));
  return {
    id: data.id,
    account,
    summary: data.summary || "(no title)",
    description: data.description || "",
    start: data.start?.dateTime || data.start?.date || "",
    end: data.end?.dateTime || data.end?.date || "",
    attendees: (data.attendees || []).map((a: any) => a.email).filter(Boolean),
    status: data.status || "confirmed",
    htmlLink: data.htmlLink || "",
    recurring: !!(data.recurrence?.length || data.recurringEventId),
    recurrence: rrule ? rrule.slice("RRULE:".length) : "",
  };
}

/** Events in [timeMin, timeMax). No account: merges every connected calendar (Google and Apple
 *  alike), since Owner's schedule can live on any of them. */
export async function listEvents(opts: { timeMin: string; timeMax: string; account?: string }): Promise<CalendarEvent[]> {
  const accounts = await resolveAccounts(opts.account);
  const perAccount = await Promise.all(
    accounts.map(async (account) => {
      if (isApple(account)) return (await icloudListEvents(appleCalendarName(account), opts.timeMin, opts.timeMax)).map((e) => fromDav(e, account));
      if (!viaOAuth(account)) return (await davListEvents(account, opts.timeMin, opts.timeMax)).map((e) => fromDav(e, account));
      const params = new URLSearchParams({
        timeMin: opts.timeMin,
        timeMax: opts.timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "50",
      });
      const data = await api(account, `/calendars/primary/events?${params}`);
      const items = (data.items || []) as any[];
      const masterIds = [...new Set(items.map((e) => e.recurringEventId).filter(Boolean) as string[])].slice(0, 10);
      const masterRules = new Map<string, string>();
      await Promise.all(
        masterIds.map(async (mid) => {
          try {
            const m = await api(account, `/calendars/primary/events/${encodeURIComponent(mid)}`);
            masterRules.set(mid, toCalendarEvent(m, account).recurrence || "");
          } catch {}
        })
      );
      return items.map((e) => {
        const ev = toCalendarEvent(e, account);
        if (e.recurringEventId && !ev.recurrence) ev.recurrence = masterRules.get(e.recurringEventId) || "";
        return ev;
      });
    })
  );
  return perAccount.flat().sort((a, b) => a.start.localeCompare(b.start));
}

export async function createEvent(opts: {
  summary: string;
  start: string;
  end: string;
  attendees?: string[];
  description?: string;
  account?: string;
  status?: "confirmed" | "tentative";
  /** "all" emails the guests. Only after Owner approved inviting them; default "none". */
  sendUpdates?: "all" | "none";
  recurrence?: string;
}): Promise<CalendarEvent> {
  const [account] = await resolveAccounts(opts.account || (await preferredAccount()));
  let rule = "";
  if (opts.recurrence) {
    rule = normalizeRecurrence(opts.recurrence);
    assertStartMatchesRule(rule, opts.start);
    opts = { ...opts, recurrence: rule };
  }
  if (isApple(account)) return fromDav(await icloudCreateEvent(appleCalendarName(account), opts), account);
  if (!viaOAuth(account)) return fromDav(await davCreateEvent(account, opts), account);
  const body: any = {
    summary: opts.summary,
    description: opts.description,
    start: { dateTime: opts.start },
    end: { dateTime: opts.end },
    status: opts.status || "confirmed",
  };
  if (rule) {
    body.recurrence = ["RRULE:" + rule];
    body.start = { dateTime: opts.start, timeZone: CHICAGO_TZ };
    body.end = { dateTime: opts.end, timeZone: CHICAGO_TZ };
  }
  if (opts.attendees?.length) body.attendees = opts.attendees.map((a) => ({ email: a }));
  const data = await api(account, `/calendars/primary/events?sendUpdates=${opts.sendUpdates || "none"}`, { method: "POST", body: JSON.stringify(body) });
  return toCalendarEvent(data, account);
}

export async function updateEvent(opts: {
  id: string;
  account: string;
  summary?: string;
  start?: string;
  end?: string;
  attendees?: string[];
  description?: string;
  status?: string;
  sendUpdates?: "all" | "none";
  recurrence?: string;
  allowRuleChange?: boolean;
}): Promise<CalendarEvent> {
  const [account] = await resolveAccounts(opts.account);
  if (isApple(account)) return fromDav(await icloudUpdateEvent(account, opts.id, opts), account);
  if (!viaOAuth(account)) return fromDav(await davUpdateEvent(account, opts.id, opts), account);
  const body: any = {};
  let oneOffZone: { start?: string; end?: string } | null = null;
  if (opts.recurrence !== undefined) {
    const cur = await api(account, `/calendars/primary/events/${opts.id}`);
    const hasSeries = !!(cur.recurrence?.length || cur.recurringEventId);
    const rule = normalizeRecurrence(opts.recurrence);
    const others = [opts.summary, opts.start, opts.end, opts.attendees, opts.description, opts.status].some((v) => v !== undefined);
    if (hasSeries) {
      if (!opts.allowRuleChange) throw new Error("Changing a repeating event's rule needs Owner's approval");
      if (others) throw new Error("Change the repeat rule on its own");
      const patchId: string = cur.recurringEventId || opts.id;
      const master = patchId === opts.id ? cur : await api(account, `/calendars/primary/events/${patchId}`);
      assertStartMatchesRule(rule, master.start?.dateTime || master.start?.date || "");
      const data = await api(account, `/calendars/primary/events/${patchId}?sendUpdates=${opts.sendUpdates || "none"}`, {
        method: "PATCH",
        body: JSON.stringify({ recurrence: ["RRULE:" + rule] }),
      });
      return toCalendarEvent(data, account);
    }
    assertStartMatchesRule(rule, opts.start || cur.start?.dateTime || cur.start?.date || "");
    body.recurrence = ["RRULE:" + rule];
    if (!cur.start?.date) {
      // Timed event: carry the Central zone so the series keeps its wall-clock time across DST.
      oneOffZone = { start: opts.start || cur.start?.dateTime, end: opts.end || cur.end?.dateTime };
    }
  }
  if (opts.summary !== undefined) body.summary = opts.summary;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.start !== undefined) body.start = { dateTime: opts.start };
  if (opts.end !== undefined) body.end = { dateTime: opts.end };
  if (opts.status !== undefined) body.status = opts.status;
  if (opts.attendees !== undefined) body.attendees = opts.attendees.map((a) => ({ email: a }));
  if (oneOffZone) {
    body.start = { dateTime: oneOffZone.start, timeZone: CHICAGO_TZ };
    body.end = { dateTime: oneOffZone.end, timeZone: CHICAGO_TZ };
  }
  const data = await api(account, `/calendars/primary/events/${opts.id}?sendUpdates=${opts.sendUpdates || "none"}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return toCalendarEvent(data, account);
}

/** Busy blocks in [timeMin, timeMax) per connected account. No account: every connected account,
 *  so a proposed slot can be checked as actually free everywhere Owner's schedule might live. */
export async function freeBusy(opts: {
  timeMin: string;
  timeMax: string;
  account?: string;
}): Promise<{ account: string; busy: { start: string; end: string }[] }[]> {
  const accounts = await resolveAccounts(opts.account);
  return Promise.all(
    accounts.map(async (account) => {
      if (isApple(account)) {
        const events = await icloudListEvents(appleCalendarName(account), opts.timeMin, opts.timeMax);
        const busy = events.filter((e) => !e.transparent && !e.allDay).map((e) => ({ start: e.start, end: e.end }));
        return { account, busy };
      }
      if (!viaOAuth(account)) {
        // CalDAV has no free/busy endpoint: busy = every event that isn't marked "show as free".
        const events = await davListEvents(account, opts.timeMin, opts.timeMax);
        const busy = events
          .filter((e) => !e.transparent && !e.allDay)
          .map((e) => ({ start: e.start, end: e.end }));
        return { account, busy };
      }
      const data = await api(account, "/freeBusy", {
        method: "POST",
        body: JSON.stringify({ timeMin: opts.timeMin, timeMax: opts.timeMax, items: [{ id: "primary" }] }),
      });
      const busy = (data.calendars?.primary?.busy || []) as { start: string; end: string }[];
      return { account, busy: busy.map((b) => ({ start: b.start, end: b.end })) };
    })
  );
}

export async function getEvent(id: string, account: string): Promise<CalendarEvent> {
  const [resolved] = await resolveAccounts(account);
  if (isApple(resolved)) return fromDav(await icloudGetEvent(resolved, id), resolved);
  if (!viaOAuth(resolved)) return fromDav(await davGetEvent(resolved, id), resolved);
  return toCalendarEvent(await api(resolved, `/calendars/primary/events/${id}`), resolved);
}

/** Cancel (delete) an event. Only ever called after Owner approves it; notifies guests if asked. */
export async function cancelEvent(id: string, account: string, sendUpdates: "all" | "none" = "none") {
  const [resolved] = await resolveAccounts(account);
  if (isApple(resolved)) return icloudCancelEvent(resolved, id);
  if (!viaOAuth(resolved)) return davCancelEvent(resolved, id);
  await api(resolved, `/calendars/primary/events/${id}?sendUpdates=${sendUpdates}`, { method: "DELETE" });
  return { cancelled: true, id, account: resolved };
}

/** Attendees who aren't one of Owner's own connected accounts (Apple ID included). */
export async function externalAttendees(attendees: string[] = []): Promise<string[]> {
  const own = new Set((await connectedCalendarAccounts()).map((e) => e.toLowerCase()));
  if (isAppleConfigured()) own.add(process.env.APPLE_ID!.toLowerCase());
  return attendees.filter((a) => !own.has(a.toLowerCase()));
}
