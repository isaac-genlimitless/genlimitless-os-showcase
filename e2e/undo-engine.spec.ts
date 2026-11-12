import { test, expect } from "@playwright/test";
import { openTestDb } from "./db-handle";
import { ensureUndoSchema } from "../src/lib/undo-log";
import { previewTurn, undoTurn, redoTurn } from "../src/lib/undo";
import db from "../src/lib/db";
import { createPage, updatePage, getPage } from "../src/lib/pages";
import { createTask, listTasks, getTask } from "../src/lib/tasks";

// Undo log, part 2: the reversal engine. Isolated e2e DB; never sends, never starts an agent.

test.beforeAll(async () => {
  openTestDb().close(); // throws unless pointed at the isolated test DB
  await ensureUndoSchema();
});

const newRun = () =>
  Number(db.prepare(`INSERT INTO agent_runs (agent_slug, trigger, prompt, status) VALUES ('chief_of_staff','test','undo-engine test','done')`).run().lastInsertRowid);

/** A finished chat reply (chat_history row linked to a run). */
function newTurn(): { chatId: number; runId: number } {
  const runId = newRun();
  const chatId = Number(db.prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant','done')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO chat_turn_runs (chat_id, run_id, thread) VALUES (?,?,'main')`).run(chatId, runId);
  return { chatId, runId };
}

function action(runId: number, entity: string, id: string | number, op: string, label: string, before: unknown, after: unknown): number {
  return Number(
    db
      .prepare(
        `INSERT INTO undo_actions (run_id, root_run_id, tool, entity, entity_id, op, label, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(runId, runId, "test", entity, String(id), op, label, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)).lastInsertRowid
  );
}

const newPage = (title: string, body: string) => createPage({ title, body, kind: "page", parent_id: null, created_by: "agent", placed_by: null } as any);

test("undo restores an edited page body and posts a chat note", async () => {
  const page = await newPage("Plan", "old body");
  const { chatId, runId } = newTurn();
  await updatePage(page.id, { body: "new body" });
  action(runId, "page", page.id, "update", 'Edited Files page "Plan"', { title: "Plan", body: "old body" }, { title: "Plan", body: "new body" });
  const notesBefore = (db.prepare(`SELECT COUNT(*) c FROM chat_history WHERE content LIKE '↩︎ Undid%'`).get() as any).c;

  const res = await undoTurn(chatId, { overwrite: [] });
  expect(res.done).toHaveLength(1);
  expect(getPage(page.id)!.body).toBe("old body");
  const notesAfter = (db.prepare(`SELECT COUNT(*) c FROM chat_history WHERE content LIKE '↩︎ Undid%'`).get() as any).c;
  expect(notesAfter).toBe(notesBefore + 1);
});

test("undoing a created page archives it (row stays); redo makes it active", async () => {
  const page = await newPage("Fresh", "x");
  const { chatId, runId } = newTurn();
  action(runId, "page", page.id, "create", 'Created Files page "Fresh"', null, { title: "Fresh", body: "x" });
  await undoTurn(chatId, { overwrite: [] });
  expect(getPage(page.id)!.status).toBe("archived");
  await redoTurn(chatId);
  expect(getPage(page.id)!.status).toBe("active");
});

test("undoing a created task sets archived_at and hides it from listTasks", async () => {
  const task: any = createTask({ title: "Undo me task" }, "agent:test");
  const { chatId, runId } = newTurn();
  action(runId, "task", task.id, "create", 'Added task "Undo me task"', null, { title: "Undo me task", status: "open" });
  await undoTurn(chatId, { overwrite: [] });
  expect(getTask(task.id)!.archived_at).toBeTruthy();
  expect(listTasks({ status: "all" }).some((t) => t.id === task.id)).toBe(false);
  expect(getTask(task.id)).not.toBeNull();
});

test("a conflicting later edit is flagged and skipped unless overwritten", async () => {
  const page = await newPage("Shared", "v0");
  const first = newTurn();
  await updatePage(page.id, { body: "v1" });
  const a1 = action(first.runId, "page", page.id, "update", 'Edited Files page "Shared"', { body: "v0" }, { body: "v1" });
  const later = newTurn();
  await updatePage(page.id, { body: "v2" });
  action(later.runId, "page", page.id, "update", 'Edited Files page "Shared" again', { body: "v1" }, { body: "v2" });

  const p = previewTurn(first.chatId);
  expect(p.reversible.find((r) => r.action_id === a1)?.conflict).toBeTruthy();

  const skipped = await undoTurn(first.chatId, { overwrite: [] });
  expect(skipped.skipped).toHaveLength(1);
  expect(getPage(page.id)!.body).toBe("v2");

  await undoTurn(first.chatId, { overwrite: [a1] });
  expect(getPage(page.id)!.body).toBe("v0");
});
