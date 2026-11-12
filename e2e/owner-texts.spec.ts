import { test, expect } from "@playwright/test";
import { getState, setState } from "../src/lib/db";
import { CURSOR_KEY, fromOwner, isOwnerTextHandle, runOwnerTextsTick, toPlainText, type OwnerText } from "../src/lib/owner-texts";
import { runInboundSweep, KEYS } from "../src/lib/inbound-sweep";

// Non-UI: fake Messages rows, fake agent run, fake reply. Never sends, never runs an agent.

test.describe.configure({ mode: "serial" });

const OWNER = "+18015550100";
const msg = (id: number, over: Partial<OwnerText> = {}): OwnerText => ({ id, handle: OWNER, chat_guid: `iMessage;-;${OWNER}`, service: "iMessage", text: `hey chief ${id}`, ...over });

test("only Owner's own 1:1 iMessages count (never SMS, group chats or other people)", () => {
  expect(isOwnerTextHandle("8015550100", OWNER)).toBe(true);
  expect(isOwnerTextHandle("+1 801 555 0199", OWNER)).toBe(false);
  expect(isOwnerTextHandle("owner@x.test", "Owner@X.test")).toBe(true);
  const rows = [
    msg(1),
    msg(2, { service: "SMS" }),
    msg(3, { chat_guid: "iMessage;+;chat99" }),
    msg(4, { handle: "+18015550199", chat_guid: "iMessage;-;+18015550199" }),
    msg(5, { text: "" }),
  ];
  expect(fromOwner(rows, OWNER).map((r) => r.id)).toEqual([1]);
});

test("first run only sets the cursor (old history is never replayed)", async () => {
  setState(CURSOR_KEY, "");
  const ran: string[] = [];
  const r = await runOwnerTextsTick({ owner: OWNER, latestRowid: () => 500, fetch: () => [msg(400)], busy: () => false, run: async (t) => (ran.push(t), { reply: "x" }), reply: async () => {} });
  expect(r.skipped).toBe("cursor initialised");
  expect(getState(CURSOR_KEY)).toBe("500");
  expect(ran).toEqual([]);
});

test("Owner's texts become one chat turn; the reply is texted back as plain text; cursor advances", async () => {
  setState(CURSOR_KEY, "500");
  const ran: string[] = [];
  const replies: string[] = [];
  const rows = [msg(501, { text: "what's on tomorrow?" }), msg(502, { handle: "+18015550199", chat_guid: "iMessage;-;+18015550199", text: "not owner" }), msg(503, { text: "and remind me to call mom" })];
  const r = await runOwnerTextsTick({
    owner: OWNER,
    latestRowid: () => 503,
    fetch: (since) => rows.filter((x) => x.id > since),
    busy: () => false,
    run: async (t) => (ran.push(t), { reply: "**Tomorrow:** 9am [Acme call](https://cal.test/1). See [tasks](/tasks)." }),
    reply: async (t) => void replies.push(t),
  });
  expect(r.handled).toBe(2);
  expect(ran).toEqual(["what's on tomorrow?\n\nand remind me to call mom"]);
  expect(replies).toEqual(["Tomorrow: 9am Acme call (https://cal.test/1). See tasks."]);
  expect(getState(CURSOR_KEY)).toBe("503");
});

test("busy main chat: waits, cursor unchanged", async () => {
  setState(CURSOR_KEY, "503");
  const r = await runOwnerTextsTick({ owner: OWNER, latestRowid: () => 504, fetch: () => [msg(504)], busy: () => true, run: async () => ({ reply: "x" }), reply: async () => {} });
  expect(r.handled).toBe(0);
  expect(getState(CURSOR_KEY)).toBe("503");
});

test("a failing run retries, then gives up after 3 tries with an apology", async () => {
  setState(CURSOR_KEY, "504");
  const replies: string[] = [];
  const deps = { owner: OWNER, latestRowid: () => 505, fetch: () => [msg(505)], busy: () => false, run: async () => { throw new Error("boom"); }, reply: async (t: string) => void replies.push(t) };
  await runOwnerTextsTick(deps);
  await runOwnerTextsTick(deps);
  expect(getState(CURSOR_KEY)).toBe("504");
  await runOwnerTextsTick(deps);
  expect(getState(CURSOR_KEY)).toBe("505");
  expect(replies[0]).toMatch(/couldn't handle that text/);
});

test("long replies are capped for a phone", () => {
  expect(toPlainText("x".repeat(5000)).length).toBeLessThanOrEqual(1200);
});

test("the inbound sweep never triages Owner's own texts to Chief, but moves past them", async () => {
  const prev = process.env.OWNER_IMESSAGE_HANDLE;
  process.env.OWNER_IMESSAGE_HANDLE = OWNER;
  try {
    setState(KEYS.textRowid, "1000");
    const prompts: string[] = [];
    const base = { now: () => Date.parse("2026-11-04T18:00:00Z"), accounts: () => [], fetchMail: () => [], runner: async (p: string) => void prompts.push(p) };
    const r = await runInboundSweep({ reason: "t" }, { ...base, latestRowid: () => 1001, fetchTexts: () => [{ id: 1001, chat_guid: `any;-;${OWNER}`, handle: OWNER, contact_name: "Owner", text: "chief, cancel my 3pm", at: "2026-11-04T17:59:00Z" }] });
    expect(r.processed).toBe(0);
    expect(prompts).toEqual([]);
    expect(getState(KEYS.textRowid)).toBe("1001");
    // Mixed batch: only the other person's text reaches the triage prompt, which now asks for commitments.
    await runInboundSweep({ reason: "t" }, {
      ...base,
      latestRowid: () => 1003,
      fetchTexts: () => [
        { id: 1002, chat_guid: `any;-;${OWNER}`, handle: OWNER, contact_name: "Owner", text: "chief ping", at: "2026-11-04T17:59:00Z" },
        { id: 1003, chat_guid: "any;-;+18015550199", handle: "+18015550199", contact_name: "Ray", text: "I'll send the contract tomorrow", at: "2026-11-04T17:59:30Z" },
      ],
    });
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("I'll send the contract tomorrow");
    expect(prompts[0]).not.toContain("chief ping");
    for (const w of ["COMMITMENTS:", "record_commitment", "owed_to_owner", "owner_owes"]) expect(prompts[0]).toContain(w);
    expect(getState(KEYS.textRowid)).toBe("1003");
  } finally {
    if (prev === undefined) delete process.env.OWNER_IMESSAGE_HANDLE;
    else process.env.OWNER_IMESSAGE_HANDLE = prev;
  }
});
