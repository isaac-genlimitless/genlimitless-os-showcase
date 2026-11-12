import { test, expect } from "@playwright/test";
import { openTestDb } from "./db-handle";
import { captureBefore, recordAfter, rootRunId, ensureUndoSchema } from "../src/lib/undo-log";
import db from "../src/lib/db";
import { createPage, updatePage } from "../src/lib/pages";
import { createTask } from "../src/lib/tasks";

// Undo log, part 1: records only. Runs on the isolated e2e DB; never sends, never starts an agent.

const ok = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const rows = (runId: number) => db.prepare(`SELECT * FROM undo_actions WHERE run_id=? ORDER BY id`).all(runId) as any[];
const newRun = (parent: number | null = null) =>
  Number(db.prepare(`INSERT INTO agent_runs (agent_slug, trigger, prompt, parent_run_id) VALUES ('chief_of_staff','test','undo-log test',?)`).run(parent).lastInsertRowid);

test.beforeAll(async () => {
  openTestDb().close(); // throws unless pointed at the isolated test DB
  await ensureUndoSchema();
});

test("update_page records before and after title/body", async () => {
  const page = await createPage({ title: "Q4 plan", body: "old body", kind: "page", parent_id: null, created_by: "agent", placed_by: null } as any);
  const run = newRun();
  await captureBefore(run, "update_page", { page_id: page.id, title: "Q4 plan v2", body: "new body" }, "tu-a");
  await updatePage(page.id, { title: "Q4 plan v2", body: "new body" } as any);
  await recordAfter(run, "chief_of_staff", "update_page", { page_id: page.id }, ok({ page_id: page.id }), "tu-a");
  const r = rows(run);
  expect(r).toHaveLength(1);
  expect(JSON.parse(r[0].before_json)).toMatchObject({ title: "Q4 plan", body: "old body" });
  expect(JSON.parse(r[0].after_json)).toMatchObject({ title: "Q4 plan v2", body: "new body" });
});

test("create_task records op create with the new task id", async () => {
  const run = newRun();
  await captureBefore(run, "create_task", { title: "Call Acme" }, "tu-b");
  const t: any = createTask({ title: "Call Acme" } as any, "agent:test");
  await recordAfter(run, "chief_of_staff", "create_task", { title: "Call Acme" }, ok(t), "tu-b");
  const r = rows(run);
  expect(r).toHaveLength(1);
  expect(r[0].op).toBe("create");
  expect(r[0].entity_id).toBe(String(t.id ?? t.task_id));
});

test("an errored tool call writes nothing", async () => {
  const run = newRun();
  await recordAfter(run, "chief_of_staff", "create_task", { title: "x" }, { isError: true, content: [{ type: "text", text: "boom" }] }, "tu-c");
  expect(rows(run)).toHaveLength(0);
});

test("a child run's root_run_id is the top of the chain", async () => {
  const parent = newRun();
  const child = newRun(parent);
  expect(rootRunId(child)).toBe(parent);
  await recordAfter(child, "marketing_director", "request_owner_approval", { title: "t" }, ok({ id: 7 }), "tu-d");
  const r = rows(child);
  expect(r[0].root_run_id).toBe(parent);
  expect(r[0].undoable).toBe(0);
});

test("an unparseable response doesn't throw", async () => {
  const run = newRun();
  await expect(recordAfter(run, "chief_of_staff", "update_task", { task_id: 1 }, "not json at all", "tu-e")).resolves.toBeUndefined();
});
