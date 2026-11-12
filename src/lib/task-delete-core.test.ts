import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTaskIds } from "./task-delete-core";

test("accepts an array 106..119", () => {
  const ids = Array.from({ length: 14 }, (_, i) => 106 + i);
  assert.deepEqual(normalizeTaskIds({ task_ids: ids }), ids);
});
test("accepts a single task_id", () => assert.deepEqual(normalizeTaskIds({ task_id: 5 }), [5]));
test("de-duplicates", () => assert.deepEqual(normalizeTaskIds({ task_id: 5, task_ids: [5, 6, 6] }), [5, 6]));
test("rejects empty", () => {
  assert.throws(() => normalizeTaskIds({}));
  assert.throws(() => normalizeTaskIds({ task_ids: [] }));
});
test("rejects 31 ids", () => assert.throws(() => normalizeTaskIds({ task_ids: Array.from({ length: 31 }, (_, i) => i + 1) })));
test("rejects negative and non-integer", () => {
  assert.throws(() => normalizeTaskIds({ task_ids: [-1] }));
  assert.throws(() => normalizeTaskIds({ task_ids: [1.5] }));
  assert.throws(() => normalizeTaskIds({ task_id: "3" }));
});
