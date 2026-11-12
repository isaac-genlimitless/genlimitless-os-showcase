import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { openTestDb } from "./db-handle";
import { ensureUndoSchema, recordAfter } from "../src/lib/undo-log";
import { previewTurn, undoTurn } from "../src/lib/undo";
import { externalCannot } from "../src/lib/undo-external";
import { writableProperty } from "../src/lib/notion";
import db from "../src/lib/db";

// Undo, part 4: calendar / mail / Notion. Nothing here reaches the network; never presses Send, never starts an agent.

const ok = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });

test.beforeAll(async () => {
  openTestDb().close(); // throws unless pointed at the isolated test DB
  await ensureUndoSchema();
});

const newRun = () =>
  Number(db.prepare(`INSERT INTO agent_runs (agent_slug, trigger, prompt, status) VALUES ('chief_of_staff','test','undo-external test','done')`).run().lastInsertRowid);

function newTurn(): { chatId: number; runId: number } {
  const runId = newRun();
  const chatId = Number(db.prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant','done')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO chat_turn_runs (chat_id, run_id, thread) VALUES (?,?,'main')`).run(chatId, runId);
  return { chatId, runId };
}

const rowsOf = (runId: number) => db.prepare(`SELECT * FROM undo_actions WHERE run_id=? ORDER BY id`).all(runId) as any[];

test("an AI-created calendar event is recorded as can't-be-undone", async () => {
  const { chatId, runId } = newTurn();
  await recordAfter(runId, "chief_of_staff", "create_calendar_event", { summary: "Lunch", account: "a@b.com", start: "2030-01-01T10:00:00Z", end: "2030-01-01T11:00:00Z" }, ok({ id: "evt1", summary: "Lunch" }), undefined);
  const rows = rowsOf(runId);
  expect(rows).toHaveLength(1);
  expect(rows[0].undoable).toBe(0);
  expect(rows[0].not_undoable_reason).toContain("cancellation");
  const p = previewTurn(chatId);
  expect(p.reversible).toHaveLength(0);
  expect(p.cannot.some((c) => /cancellation/.test(c.reason))).toBe(true);
  await expect(undoTurn(chatId, { overwrite: [] })).rejects.toThrow(/Nothing left to undo/);
});

test("an old-style undoable calendar create row is never reversible", async () => {
  const { chatId, runId } = newTurn();
  db.prepare(
    `INSERT INTO undo_actions (run_id, root_run_id, tool, entity, entity_id, op, label, before_json, after_json, undoable) VALUES (?,?,?,?,?,?,?,?,?,1)`
  ).run(runId, runId, "create_calendar_event", "calendar_event", "evt-old", "create", "Created calendar event", null, JSON.stringify({ id: "evt-old", account: "a@b.com" }));
  const p = previewTurn(chatId);
  expect(p.reversible).toHaveLength(0);
  expect(p.cannot).toHaveLength(1);
});

test("Notion append and property edits without a captured before-state are not undoable", async () => {
  const { runId } = newTurn();
  await recordAfter(runId, "chief_of_staff", "notion_append", { page: "abc", markdown: "hi" }, ok({ id: "abc", appended: true }), undefined);
  await recordAfter(runId, "chief_of_staff", "notion_update_properties", { page: "abc", properties_json: "{}" }, ok({ id: "abc" }), undefined);
  const rows = rowsOf(runId);
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.undoable === 0)).toBe(true);
});

test("externalCannot explains rows that can't be reversed", () => {
  const base = { id: 1, entity_id: "x", undoable: 1, not_undoable_reason: null };
  const row = (o: any) => ({ ...base, before_json: null, after_json: null, ...o });
  const J = JSON.stringify;
  expect(externalCannot(row({ entity: "calendar_event", op: "update", before_json: J({ summary: "a", account: "a@b.com" }), after_json: J({ account: "a@b.com" }) }))).toBeTruthy();
  expect(
    externalCannot(row({ entity: "calendar_event", op: "update", before_json: J({ start: "x", recurrence: "R1" }), after_json: J({ start: "x", account: "a@b.com", recurrence: "R2" }) }))
  ).toMatch(/Repeat-rule/);
  expect(externalCannot(row({ entity: "mail", op: "organize", before_json: J({}), after_json: J({ account: "a@b.com", action: "archive" }) }))).toBeTruthy();
  expect(
    externalCannot(row({ entity: "mail", op: "organize", before_json: J({ state: { m1: { unread: true, starred: false, inbox: true, labeled: false } } }), after_json: J({ account: "a@b.com", action: "archive" }) }))
  ).toBeNull();
  expect(externalCannot(row({ entity: "notion_page", op: "create", entity_id: "page1" }))).toBeNull();
});

test("writableProperty maps supported types and rejects formula/rollup", () => {
  expect(writableProperty({ type: "select", select: { id: "1", name: "Open", color: "red" } })).toEqual({ select: { name: "Open" } });
  expect(writableProperty({ type: "status", status: { name: "Done" } })).toEqual({ status: { name: "Done" } });
  expect(writableProperty({ type: "date", date: { start: "2030-01-01", end: null } })).toEqual({ date: { start: "2030-01-01", end: null, time_zone: null } });
  expect(writableProperty({ type: "multi_select", multi_select: [{ id: "1", name: "A" }] })).toEqual({ multi_select: [{ name: "A" }] });
  expect(writableProperty({ type: "checkbox", checkbox: true })).toEqual({ checkbox: true });
  expect(writableProperty({ type: "title", title: [{ plain_text: "Hi" }] })).toEqual({ title: [{ type: "text", text: { content: "Hi" } }] });
  expect(writableProperty({ type: "formula", formula: {} })).toBeUndefined();
  expect(writableProperty({ type: "rollup", rollup: {} })).toBeUndefined();
});

test("undo-external source never cancels, trashes, deletes or notifies", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "undo-external.ts"), "utf8");
  for (const bad of ["cancelEvent", "trashMail", "trashMessage", 'method: "DELETE"', 'sendUpdates: "all"']) {
    expect(src.includes(bad)).toBe(false);
  }
});
