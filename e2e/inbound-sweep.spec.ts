import { test, expect } from "@playwright/test";
import { getState, setState } from "../src/lib/db";
import { runInboundSweep, checkSweepHealth, KEYS } from "../src/lib/inbound-sweep";

// Unit-style: fake fetchers/runner/notifier. Never sends, never triggers a real agent.
const ACCT = "sweeptest@example.com";
const clear = () => {
  for (const k of [KEYS.textRowid, KEYS.mailCursor(ACCT), KEYS.mailSeen(ACCT), KEYS.lastOk, KEYS.lastStart, KEYS.alertedAt]) {
    setState(k, "");
  }
};
const T0 = Date.parse("2026-10-13T12:00:00Z");
const deps = (runner: (p: string) => Promise<unknown>) => ({
  now: () => T0,
  latestRowid: () => 1000,
  fetchTexts: (since: number) =>
    [{ id: 1001, chat_guid: "g1", handle: "+1555", contact_name: "Mom", text: "dinner at 6?", at: "2026-10-13T11:50:00Z" }].filter((r) => r.id > since),
  accounts: () => [{ email: ACCT, kind: "gmail_oauth" }],
  fetchMail: () => [{ id: "m1", from: "a@b.c", subject: "Interview", date: "2026-10-13T11:55:00Z", text: "Tuesday 3pm", snippet: "" }],
  runner,
});

test.describe.configure({ mode: "serial" });

test("new items reach the runner and cursors advance; second run passes nothing", async () => {
  clear();
  setState(KEYS.textRowid, "1000");
  const prompts: string[] = [];
  const live = (runner: (p: string) => Promise<unknown>) => ({ ...deps(runner), latestRowid: () => 1001 }); // the newest text exists in chat.db
  const r1 = await runInboundSweep({ reason: "t" }, live(async (p) => void prompts.push(p)));
  expect(r1.processed).toBe(2);
  expect(prompts[0]).toContain("dinner at 6?");
  expect(prompts[0]).toContain("Interview");
  // Chief-of-staff triage: tasks, calendar, reminder texts, resolving tasks, no duplicates.
  for (const w of ["TASK:", "CALENDAR:", "REMINDER TEXT:", "RESOLVE:", "schedule_text_owner", "list_tasks"]) expect(prompts[0]).toContain(w);
  expect(getState(KEYS.textRowid)).toBe("1001");
  expect(getState(KEYS.mailCursor(ACCT))).toBe("2026-10-13T11:55:00.000Z");
  const r2 = await runInboundSweep({ reason: "t" }, live(async (p) => void prompts.push(p)));
  expect(r2.processed).toBe(0);
  expect(prompts.length).toBe(1);
});

test("runner failure leaves cursors unchanged", async () => {
  clear();
  setState(KEYS.textRowid, "1000");
  const r = await runInboundSweep({ reason: "t" }, deps(async () => { throw new Error("boom"); }));
  expect(r.processed).toBe(0);
  expect(getState(KEYS.textRowid)).toBe("1000");
  expect(getState(KEYS.mailCursor(ACCT)) || "").toBe("");
});

test("cursors persist across a re-import", async () => {
  clear();
  setState(KEYS.textRowid, "1000");
  await runInboundSweep({ reason: "t" }, deps(async () => undefined));
  const again = await import("../src/lib/db?reimport=" + Date.now()).catch(() => null);
  const gs = again ? (again as any).getState : getState;
  expect(gs(KEYS.textRowid)).toBe("1001");
});

const none = { fetchMail: () => [] as any[], accounts: () => [] as any[] };

test("corrupt text cursor rescans last 200", async () => {
  clear();
  setState(KEYS.textRowid, "abc");
  const sinces: number[] = [];
  await runInboundSweep({ reason: "t" }, { now: () => T0, latestRowid: () => 1000, fetchTexts: (s: number) => { sinces.push(s); return []; }, ...none, runner: async () => undefined });
  expect(sinces).toEqual([800]);
});

test("text cursor beyond latest rescans last 200", async () => {
  clear();
  setState(KEYS.textRowid, "5000");
  const sinces: number[] = [];
  await runInboundSweep({ reason: "t" }, { now: () => T0, latestRowid: () => 1000, fetchTexts: (s: number) => { sinces.push(s); return []; }, ...none, runner: async () => undefined });
  expect(sinces).toEqual([800]);
});

test("legacy account gets an after: query", async () => {
  clear();
  const qs: string[] = [];
  await runInboundSweep({ reason: "t" }, { ...deps(async () => undefined), accounts: () => [{ email: ACCT, kind: "imap" }], fetchMail: (_e: string, q: string) => { qs.push(q); return []; } });
  expect(qs[0].startsWith("after:")).toBe(true);
});

test("corrupt mail cursor falls back to about 7 days, never NaN", async () => {
  clear();
  setState(KEYS.mailCursor(ACCT), "garbage");
  const qs: string[] = [];
  await runInboundSweep({ reason: "t" }, { ...deps(async () => undefined), fetchMail: (_e: string, q: string) => { qs.push(q); return []; } });
  expect(qs[0]).not.toContain("NaN");
  const sec = Number(qs[0].replace("after:", ""));
  expect(Math.abs(sec - (Math.floor(T0 / 1000) - 7 * 86400 - 60))).toBeLessThan(5);
});

test("100 mail rows triggers a refetch with limit 500", async () => {
  clear();
  const limits: number[] = [];
  const row = (i: number) => ({ id: "x" + i, from: "a@b.c", subject: "s", date: "2026-10-13T11:55:00Z", text: "t", snippet: "" });
  await runInboundSweep({ reason: "t" }, { ...deps(async () => undefined), fetchMail: (_e: string, _q: string, l: number) => { limits.push(l); return l === 100 ? Array.from({ length: 100 }, (_, i) => row(i)) : []; } });
  expect(limits).toEqual([100, 500]);
});

test("health alert fires when stale, not when fresh, not twice within 6h", async () => {
  clear();
  const sent: string[] = [];
  const notifier = async (i: { message: string }) => void sent.push(i.message);
  setState(KEYS.lastOk, String(T0 - 5 * 60 * 1000));
  expect(await checkSweepHealth({ now: () => T0, notifier })).toBe(false);
  setState(KEYS.lastOk, String(T0 - 2 * 60 * 60 * 1000));
  expect(await checkSweepHealth({ now: () => T0, notifier })).toBe(true);
  expect(sent.length).toBe(1);
  expect(await checkSweepHealth({ now: () => T0 + 60 * 60 * 1000, notifier })).toBe(false);
  expect(sent.length).toBe(1);
});
