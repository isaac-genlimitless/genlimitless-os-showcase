import { test, expect } from "@playwright/test";
import db from "../src/lib/db";
import {
  autopilotSuggestions,
  holdSend,
  inSendingWindow,
  maybeScheduleAutopilot,
  normalizeTextHandle,
  recordDecision,
  runAutopilotTick,
  setPaused,
  singleEmail,
  textRecipient,
  turnOffAutopilot,
  turnOnAutopilot,
  declineSuggestion,
  PER_RECIPIENT_DAILY_CAP,
} from "../src/lib/autopilot";
import { toSqliteUtc } from "../src/lib/time";

// Non-UI, throwaway DB. NEVER sends: every tick gets a fake loadDraft/send.

test.describe.configure({ mode: "serial" });

const uniqEmail = () => `ap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
let draftSeq = 900000 + Math.floor(Math.random() * 50000);
const nextDraft = () => ++draftSeq;
const row = (id: number) => db.prepare(`SELECT * FROM autopilot_sends WHERE id=?`).get(id) as { status: string; send_at: string; note: string | null; body_hash: string };
// 2026-11-04 15:00 UTC = 9:00am Central (inside the 7am-9pm window).
const NOON = new Date("2026-11-04T18:00:00Z");

test.beforeEach(() => setPaused(false));

test("recipient rules: exactly one email; 1:1 texts only, never group chats", () => {
  expect(singleEmail("Dana <DANA@acme.test>")).toBe("dana@acme.test");
  expect(singleEmail("a@x.test, b@x.test")).toBeNull();
  expect(singleEmail("")).toBeNull();
  expect(normalizeTextHandle("+1 (801) 555-1234")).toBe("8015551234");
  expect(textRecipient({ chat_guid: "any;-;+18015551234" })).toBe("8015551234");
  expect(textRecipient({ chat_guid: "any;+;chat123456" })).toBeNull();
});

test("sending window: 7am-9pm Central only", () => {
  expect(inSendingWindow(NOON).getTime()).toBe(NOON.getTime());
  const late = new Date("2026-11-05T04:00:00Z"); // 10pm Central Nov 4
  expect(inSendingWindow(late).toISOString()).toBe("2026-11-05T13:00:00.000Z"); // 7am CST Nov 5
  const early = new Date("2026-11-04T10:00:00Z"); // 4am Central
  expect(inSendingWindow(early).toISOString()).toBe("2026-11-04T13:00:00.000Z");
});

test("nothing is scheduled for someone who isn't on Autopilot", () => {
  expect(maybeScheduleAutopilot("email", { id: nextDraft(), recipient: uniqEmail(), body: "hi" }, NOON)).toBeNull();
});

test("suggestion after 5 unchanged approvals; an edit resets the streak; decline hides it", () => {
  const who = uniqEmail();
  for (let i = 0; i < 4; i++) recordDecision("email", who, nextDraft(), "approved_unchanged", who);
  expect(autopilotSuggestions().some((s) => s.recipient === who)).toBe(false);
  recordDecision("email", who, nextDraft(), "approved_unchanged", who);
  const s = autopilotSuggestions().find((x) => x.recipient === who);
  expect(s?.approved_in_a_row).toBe(5);
  recordDecision("email", who, nextDraft(), "approved_edited", who);
  expect(autopilotSuggestions().some((x) => x.recipient === who)).toBe(false);
  const other = uniqEmail();
  for (let i = 0; i < 5; i++) recordDecision("email", other, nextDraft(), "approved_unchanged", other);
  declineSuggestion("email", other);
  expect(autopilotSuggestions().some((x) => x.recipient === other)).toBe(false);
});

test("trusted recipient: scheduled after the hold window, sent by the tick (fake sender)", async () => {
  const who = uniqEmail();
  turnOnAutopilot({ kind: "email", recipient: who, label: "Test Person", delay_min: 30 });
  const id = nextDraft();
  const body = `${who}\nRe: hi\nSounds good, see you then.`;
  const s = maybeScheduleAutopilot("email", { id, recipient: who, body }, NOON)!;
  expect(s).toBeTruthy();
  expect(s.send_at).toBe(toSqliteUtc(new Date(NOON.getTime() + 30 * 60_000)));
  const sent: number[] = [];
  const deps = { loadDraft: () => ({ status: "pending_approval", recipient: who, body }), send: async (_k: string, d: number) => void sent.push(d) };
  // Not due yet.
  await runAutopilotTick({ ...deps, now: () => new Date(NOON.getTime() + 10 * 60_000) });
  expect(sent).toEqual([]);
  const r = await runAutopilotTick({ ...deps, now: () => new Date(NOON.getTime() + 31 * 60_000) });
  expect(r.sent).toBe(1);
  expect(sent).toEqual([id]);
  expect(row(s.id).status).toBe("sent");
});

test("an edit restarts the hold window; a recipient change holds it; a handled draft is skipped", async () => {
  const who = uniqEmail();
  turnOnAutopilot({ kind: "email", recipient: who, delay_min: 30 });
  const sent: number[] = [];
  const send = async (_k: string, d: number) => void sent.push(d);
  const due = () => new Date(NOON.getTime() + 31 * 60_000);

  const a = maybeScheduleAutopilot("email", { id: nextDraft(), recipient: who, body: "v1" }, NOON)!;
  const r1 = await runAutopilotTick({ now: due, send, loadDraft: () => ({ status: "pending_approval", recipient: who, body: "v2 edited" }) });
  expect(r1.rescheduled).toBe(1);
  expect(row(a.id).status).toBe("scheduled");
  expect(row(a.id).send_at > toSqliteUtc(due())).toBe(true);

  const b = maybeScheduleAutopilot("email", { id: nextDraft(), recipient: who, body: "v1" }, NOON)!;
  await runAutopilotTick({ now: due, send, loadDraft: (_k, id) => (id === b.draft_id ? { status: "pending_approval", recipient: "someone-else@x.test", body: "v1" } : null) });
  expect(row(b.id).status).toBe("held");

  const c = maybeScheduleAutopilot("email", { id: nextDraft(), recipient: who, body: "v1" }, NOON)!;
  await runAutopilotTick({ now: due, send, loadDraft: (_k, id) => (id === c.draft_id ? { status: "sent", recipient: who, body: "v1" } : null) });
  expect(row(c.id).status).toBe("skipped");
  expect(sent).toEqual([]);
});

test("Hold, turning off, and global pause all stop a send", async () => {
  const who = uniqEmail();
  const t = turnOnAutopilot({ kind: "email", recipient: who, delay_min: 5 });
  const sent: number[] = [];
  const deps = { now: () => new Date(NOON.getTime() + 60 * 60_000), send: async (_k: string, d: number) => void sent.push(d), loadDraft: () => ({ status: "pending_approval", recipient: who, body: "x" }) };

  const a = maybeScheduleAutopilot("email", { id: nextDraft(), recipient: who, body: "x" }, NOON)!;
  holdSend(a.id);
  expect(row(a.id).status).toBe("held");

  const b = maybeScheduleAutopilot("email", { id: nextDraft(), recipient: who, body: "x" }, NOON)!;
  setPaused(true);
  await runAutopilotTick(deps);
  expect(row(b.id).status).toBe("scheduled");
  expect(maybeScheduleAutopilot("email", { id: nextDraft(), recipient: who, body: "x" }, NOON)).toBeNull(); // paused: nothing new
  setPaused(false);

  turnOffAutopilot(t.id);
  expect(row(b.id).status).toBe("held");
  await runAutopilotTick(deps);
  expect(sent).toEqual([]);
});

test("Owner acting on the draft himself cancels its countdown", () => {
  const who = uniqEmail();
  turnOnAutopilot({ kind: "email", recipient: who });
  const id = nextDraft();
  const s = maybeScheduleAutopilot("email", { id, recipient: who, body: "x" }, NOON)!;
  recordDecision("email", who, id, "approved_unchanged");
  expect(row(s.id).status).toBe("skipped");
});

test("per-recipient daily cap holds the extra sends", async () => {
  const who = uniqEmail();
  turnOnAutopilot({ kind: "email", recipient: who, delay_min: 5 });
  const sent: number[] = [];
  const deps = { now: () => new Date(NOON.getTime() + 60 * 60_000), send: async (_k: string, d: number) => void sent.push(d), loadDraft: () => ({ status: "pending_approval", recipient: who, body: "x" }) };
  const ids = Array.from({ length: PER_RECIPIENT_DAILY_CAP + 1 }, () => maybeScheduleAutopilot("email", { id: nextDraft(), recipient: who, body: "x" }, NOON)!.id);
  // decided_at uses the real clock, so the 24h window counts these sends.
  await runAutopilotTick(deps);
  expect(sent.length).toBe(PER_RECIPIENT_DAILY_CAP);
  expect(row(ids[ids.length - 1]).status).toBe("held");
});

test("turnOnAutopilot validates its input", () => {
  expect(() => turnOnAutopilot({ kind: "email", recipient: "a@x.test, b@x.test" })).toThrow(/exactly one/);
  expect(() => turnOnAutopilot({ kind: "email", recipient: uniqEmail(), delay_min: 1 })).toThrow(/delay_min/);
});
