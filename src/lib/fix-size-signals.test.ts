// Unit tests: size flag only counts real removals. Pure; no db, network, sends or agents.
import test from "node:test";
import assert from "node:assert/strict";
import { assessRemoval } from "./fix-size-signals";

const r = (change: string, files: string[] = []) => assessRemoval(files, change).removes;

test("explicit signals beat negation", () => {
  assert.equal(r("never delete the old file; git rm src/a.ts"), true);
  assert.equal(r("never delete the old note; git rm src/a.ts"), true);
  assert.equal(r("do not rm src/a.ts at all"), true);
  assert.equal(r("we will never run rm -rf data/x"), true);
  assert.equal(r("no unlink src/x.ts"), true);
  assert.equal(r("call fs.unlinkSync(p)"), true);
  assert.equal(r("never\ndiff --git a/x b/x\ndeleted file mode 100644\n"), true);
  assert.equal(r("no\nDELETE FILE: src/old.ts"), true);
});

test("negated prose only is minor", () => {
  assert.equal(r("never delete the old file", ["src/a.ts"]), false);
  assert.equal(r("this does not remove any files"), false);
  assert.equal(r("no files removed, removes a few lines"), false);
});

test("un-negated prose stays major", () => {
  assert.equal(r("rm the old file"), true);
});

test("fallback: removal evidence keeps negated prose major", () => {
  assert.equal(r("never delete the old file", ["D src/a.ts"]), true);
  assert.equal(r("never delete the old file", ["src/a.ts (deleted)"]), true);
  assert.equal(r("never delete the old file\n+++ /dev/null\n"), true);
});

test("no signal", () => {
  assert.equal(r("adds a helper function"), false);
});
