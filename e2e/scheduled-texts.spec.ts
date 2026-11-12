import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import db from "../src/lib/db";
import * as stModule from "../src/lib/scheduled-texts";
import { parseSendAt, scheduleText, sendDueScheduledTexts, requestCancelScheduledText, seedScheduledTextsOnce } from "../src/lib/scheduled-texts";
import { decideApproval } from "../src/lib/agents/approvals";
import { permsFor } from "../src/lib/agents/runtime";
import { assignableCatalog } from "../src/lib/agents/tools";
import { runScheduledTextsTick } from "../src/lib/scheduler";
import { toSqliteUtc } from "../src/lib/time";

// Non-UI. Never sends anything: every send uses an injected fake sender.

const uniq = (p: string) => `${p} ${Date.now()}-${Math.random().toString(36).slice(2)}`;
const insertRow = (message: string, sendAt: string) =>
  Number(db.prepare(`INSERT INTO scheduled_texts (message, send_at, reason, requested_by) VALUES (?,?,?,?)`).run(message, sendAt, "test", "test").lastInsertRowid);
const getRow = (id: number) => db.prepare(`SELECT * FROM scheduled_texts WHERE id=?`).get(id) as any;
// scheduled_texts.send_id REFERENCES imessage_sends(id); fixture rows live only in the throwaway DB.
const ensureSend = (id: number) =>
  db.prepare("INSERT OR IGNORE INTO imessage_sends (id, text, purpose, status) VALUES (?, 'test fixture', 'alert', 'delivered')").run(id);
const ago = (ms: number) => toSqliteUtc(new Date(Date.now() - ms));
const future = (ms: number) => new Date(Date.now() + ms);
const fmtLocal = (d: Date) => d.toISOString().slice(0, 19) + "Z";

test("parseSendAt handles Central time, DST and bad input", () => {
  expect(parseSendAt("2026-10-07 07:30")?.toISOString()).toBe("2026-10-07T12:30:00.000Z");
  expect(parseSendAt("2026-11-02 07:30")?.toISOString()).toBe("2026-11-02T13:30:00.000Z");
  expect(parseSendAt("2026-10-07T07:30:00-05:00")?.toISOString()).toBe("2026-10-07T12:30:00.000Z");
  expect(parseSendAt("2026-02-31 10:00")).toBeNull();
  expect(parseSendAt("garbage")).toBeNull();
});

test("scheduleText validates and de-duplicates", () => {
  const base = { reason: "test", requested_by: "test" };
  const at = fmtLocal(future(3 * 86_400_000));
  expect(() => scheduleText({ ...base, message: "", send_at: at })).toThrow();
  expect(() => scheduleText({ ...base, message: "x".repeat(301), send_at: at })).toThrow();
  expect(() => scheduleText({ ...base, message: "hi", send_at: fmtLocal(new Date(Date.now() - 3_600_000)) })).toThrow(/past/);
  expect(() => scheduleText({ ...base, message: "hi", send_at: "nope" })).toThrow();
  const msg = uniq("valid");
  const a: any = scheduleText({ ...base, message: msg, send_at: at });
  expect(a.status).toBe("pending");
  const b: any = scheduleText({ ...base, message: msg, send_at: at });
  expect(b.duplicate).toBe(true);
  expect(b.scheduled_text_id).toBe(a.scheduled_text_id);
  db.prepare(`UPDATE scheduled_texts SET status='cancelled' WHERE id=?`).run(a.scheduled_text_id);
});

test("sends once, catches up late texts with a note", async () => {
  ensureSend(1);
  const m1 = uniq("recent"), m2 = uniq("late");
  const id1 = insertRow(m1, ago(60_000));
  const id2 = insertRow(m2, ago(3 * 3_600_000));
  const sent: string[] = [];
  const deps = { send: async (t: string) => { sent.push(t); return 1; }, alert: async () => {} };
  const scoped = { ...deps, ids: [id1, id2] };
  await sendDueScheduledTexts(scoped);
  await sendDueScheduledTexts(scoped);
  await Promise.all([sendDueScheduledTexts(scoped), sendDueScheduledTexts(scoped)]);
  expect(sent.filter((t) => t.startsWith(m1))).toEqual([m1]);
  const late = sent.filter((t) => t.startsWith(m2));
  expect(late.length).toBe(1);
  expect(late[0]).toContain("(scheduled for");
  expect(getRow(id1).status).toBe("sent");
  expect(getRow(id2).status).toBe("sent");
  expect(getRow(id1).send_id).toBe(1);
  // test rows are hidden from the list, so check the delivery join with a non-test requester
  db.prepare(`UPDATE scheduled_texts SET requested_by='probe' WHERE id=?`).run(id1);
  // fake send id 1 must not read as delivered (no matching imessage_sends row)
  expect(stModule.listScheduledTexts("all").find((r: any) => r.id === id1)?.delivery_status ?? null).toBeNull();
  const sid = Number(db.prepare(`INSERT INTO imessage_sends (text, purpose, status) VALUES (?, 'alert', 'delivered')`).run(m1).lastInsertRowid);
  db.prepare(`UPDATE scheduled_texts SET send_id=? WHERE id=?`).run(sid, id1);
  expect(stModule.listScheduledTexts("all").find((r: any) => r.id === id1)?.delivery_status).toBe("delivered");
  db.prepare(`UPDATE scheduled_texts SET requested_by='test' WHERE id=?`).run(id1);
});

test("retries plain failures, never resends when delivery already handled it", async () => {
  const id = insertRow(uniq("retry"), ago(60_000));
  let calls = 0, alerts = 0;
  const deps = { send: async () => { calls++; throw new Error("boom"); }, alert: async () => { alerts++; } };
  await sendDueScheduledTexts({ ...deps, ids: [id] });
  let row = getRow(id);
  expect(row.status).toBe("pending");
  expect(row.attempts).toBe(1);
  expect(row.next_attempt_at > toSqliteUtc(new Date())).toBe(true);
  await sendDueScheduledTexts({ ...deps, ids: [id] });
  expect(calls).toBe(1);
  for (let i = 0; i < 2; i++) {
    db.prepare(`UPDATE scheduled_texts SET next_attempt_at=? WHERE id=?`).run(ago(60_000), id);
    await sendDueScheduledTexts({ ...deps, ids: [id] });
  }
  row = getRow(id);
  expect(row.status).toBe("failed");
  expect(calls).toBe(3);
  expect(alerts).toBe(1);

  ensureSend(5);
  const id2 = insertRow(uniq("handled"), ago(60_000));
  let alerts2 = 0, calls2 = 0;
  await sendDueScheduledTexts({ send: async () => { calls2++; throw Object.assign(new Error("x"), { sendId: 5 }); }, alert: async () => { alerts2++; }, ids: [id2] });
  expect(getRow(id2).status).toBe("failed");
  expect(alerts2).toBe(0);
  expect(calls2).toBe(1);
});

test("cancel only happens through an approved request", async () => {
  let sentCount = 0;
  const id = insertRow(uniq("cancel-a"), toSqliteUtc(future(86_400_000)));
  const req: any = requestCancelScheduledText({ id, reason: "test", requested_by: "test" });
  expect(getRow(id).status).toBe("pending");
  const ap = db.prepare(`SELECT * FROM approval_requests WHERE id=?`).get(req.request_id) as any;
  expect(ap.action).toBe("cancel_scheduled_text");
  await decideApproval(req.request_id, "decline");
  expect(getRow(id).status).toBe("pending");

  const id2 = insertRow(uniq("cancel-b"), toSqliteUtc(future(86_400_000)));
  const req2: any = requestCancelScheduledText({ id: id2, reason: "test", requested_by: "test" });
  await decideApproval(req2.request_id, "approve");
  expect(getRow(id2).status).toBe("cancelled");
  await sendDueScheduledTexts({ send: async () => { sentCount++; return 1; }, alert: async () => {}, now: () => future(2 * 86_400_000), ids: [id2] });
  expect(getRow(id2).status).toBe("cancelled");
  db.prepare(`UPDATE scheduled_texts SET status='cancelled' WHERE id=?`).run(id);
});

test("guardrails: no recipient anywhere, only Chief has the tools", () => {
  const cols = (db.prepare(`PRAGMA table_info(scheduled_texts)`).all() as any[]).map((c) => c.name);
  expect(cols.some((c) => /recipient|^to|handle|phone/i.test(c))).toBe(false);
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/agents/tools.ts"), "utf8");
  const start = src.indexOf('tool("schedule_text_owner"');
  const block = src.slice(start, src.indexOf('tool("list_scheduled_texts"'));
  // Check the parameter schema + handler only; the prose description legitimately says "no recipient option".
  const schemaAndHandler = block.slice(block.indexOf("{ message:"));
  expect(schemaAndHandler).not.toMatch(/recipient|to_handle|phone/i);
  const names = ["schedule_text_owner", "list_scheduled_texts", "cancel_scheduled_text"];
  for (const slug of ["chief_of_staff"]) {
    const p = permsFor({ slug } as any);
    for (const n of names) expect(p.mcp.has(n)).toBe(true);
  }
  const eng = permsFor({ slug: "full_stack_engineer" } as any);
  for (const n of names) expect(eng.mcp.has(n)).toBe(false);
  const cat = assignableCatalog().map((c) => c.name);
  expect(cat).toContain("schedule_text_owner");
  expect(cat).toContain("list_scheduled_texts");
  expect(cat).not.toContain("cancel_scheduled_text");
  expect(cat).not.toContain("text_owner");
  // schedule_text_owner's schema is exactly message, send_at, reason, as_agent: no recipient key
  const schemaKeys = schemaAndHandler.slice(0, schemaAndHandler.indexOf("}") + 1);
  expect(schemaKeys).toMatch(/message/);
  expect(schemaKeys).toMatch(/send_at/);
  expect(schemaKeys).not.toMatch(/\b(to|recipient|phone|handle)\b\s*:/i);
});

test("seed runs exactly once", () => {
  seedScheduledTextsOnce();
  seedScheduledTextsOnce();
  const rows = db.prepare(`SELECT * FROM scheduled_texts WHERE message='Write your talk for Sunday (Oct 11) now.'`).all() as any[];
  expect(rows.length).toBe(1);
  expect(rows[0].send_at).toBe("2026-10-07 12:30:00");
});

test("scheduler tick calls the module's CURRENT export", async () => {
  const original = stModule.runScheduledTextsTick;
  let called = false;
  try {
    (stModule as any).runScheduledTextsTick = async () => { called = true; };
    await runScheduledTextsTick();
    expect(called).toBe(true);
  } finally {
    (stModule as any).runScheduledTextsTick = original;
  }
});
