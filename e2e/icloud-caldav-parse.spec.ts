import { test, expect } from "@playwright/test";
import { parseCalendarList, parseHref, describeListing } from "../src/lib/icloud-caldav";

// Pure-function tests: no browser, no network, nothing sent.

const BASE = "https://p03-caldav.icloud.com/123/calendars/";

function fixtures(p: string, c: string, ns: string) {
  const principal = `<${p}multistatus ${ns}><${p}response><${p}href>/</${p}href><${p}propstat><${p}prop><${p}current-user-principal><${p}href>/123/principal/</${p}href></${p}current-user-principal></${p}prop></${p}propstat></${p}response></${p}multistatus>`;
  const home = `<${p}multistatus ${ns}><${p}response><${p}propstat><${p}prop><${c}calendar-home-set><${p}href>https://p03-caldav.icloud.com/123/calendars/</${p}href></${c}calendar-home-set></${p}prop></${p}propstat></${p}response></${p}multistatus>`;
  const cal = (href: string, name: string) =>
    `<${p}response><${p}href>${href}</${p}href><${p}propstat><${p}prop><${p}resourcetype><${p}collection/><${c}calendar/></${p}resourcetype><${p}displayname>${name}</${p}displayname></${p}prop></${p}propstat></${p}response>`;
  const list = `<${p}multistatus ${ns}><${p}response><${p}href>/123/calendars/</${p}href><${p}propstat><${p}prop><${p}resourcetype><${p}collection/></${p}resourcetype><${p}displayname>Home set</${p}displayname></${p}prop></${p}propstat></${p}response>${cal("/123/calendars/home/", "Home")}${cal("/123/calendars/apply/", "Apply")}</${p}multistatus>`;
  return { principal, home, list };
}

const CASES: [string, string, string, string][] = [
  ["d:-prefixed", "d:", "c:", `xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"`],
  ["unprefixed default namespace", "", "C:", `xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"`],
  ["D:-prefixed", "D:", "C:", `xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"`],
];

const CALNS = `xmlns="urn:ietf:params:xml:ns:caldav"`;
const resp = (href: string, rt: string, name?: string) =>
  `<response xmlns="DAV:"><href>${href}</href><propstat><prop><resourcetype>${rt}</resourcetype>${name ? `<displayname>${name}</displayname>` : ""}</prop></propstat></response>`;
const HOME_ONLY = `<multistatus xmlns="DAV:">${resp("/123/calendars/", "<collection/>")}</multistatus>`;
const ICLOUD_LIST = `<multistatus xmlns="DAV:">${resp("/123/calendars/", "<collection/>")}${resp("/123/calendars/home/", `<collection/><calendar ${CALNS}/>`, "Home")}${resp("/123/calendars/apply/", `<collection/><calendar ${CALNS}/>`, "Apply")}${resp("/123/calendars/inbox/", `<collection/><schedule-inbox ${CALNS}/>`)}</multistatus>`;

test("iCloud real shape: calendar with its own xmlns", () => {
  expect(parseCalendarList(ICLOUD_LIST, BASE).map((x) => x.name)).toEqual(["Home", "Apply"]);
});

test("calendar open/close form recognised; inbox with calendar+schedule-inbox excluded", () => {
  const xml = `<multistatus xmlns="DAV:">${resp("/123/calendars/a/", `<collection/><calendar ${CALNS}></calendar>`, "A")}${resp("/123/calendars/inbox/", `<collection/><calendar/><schedule-inbox/>`)}</multistatus>`;
  expect(parseCalendarList(xml, BASE).map((x) => x.name)).toEqual(["A"]);
});

test("describeListing reports entries, hrefs and resourcetypes", () => {
  const one = describeListing({ status: 207, text: HOME_ONLY });
  expect(one).toContain("1 <response> entries");
  expect(one).toContain("/123/calendars/");
  expect(one).toContain("[collection]");
  expect(describeListing({ status: 207, text: ICLOUD_LIST })).toContain("4 <response> entries");
  expect(describeListing({ status: 207, text: `<multistatus xmlns="DAV:">${resp("/a/", "<collection/>")}${resp("/b/", "<collection/>")}${resp("/c/", "<collection/>")}</multistatus>` })).toContain("3 <response> entries");
});

for (const [label, p, c, ns] of CASES) {
  test(`iCloud discovery parsing: ${label}`, () => {
    const f = fixtures(p, c, ns);
    expect(parseHref(f.principal, "current-user-principal")).toBe("/123/principal/");
    expect(parseHref(f.home, "calendar-home-set")).toBe("https://p03-caldav.icloud.com/123/calendars/");
    const names = parseCalendarList(f.list, BASE).map((x) => x.name);
    expect(names).toEqual(["Home", "Apply"]);
  });
}
