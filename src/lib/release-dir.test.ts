// Unit test for the release resolver using a temp releases dir. No network, never sends.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveReleaseDir } from "./release-dir";

test("resolves live release via current symlink at call time and honours targetRelease", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
  fs.mkdirSync(path.join(root, "releases", "aaa111"), { recursive: true });
  fs.mkdirSync(path.join(root, "releases", "bbb222"), { recursive: true });
  fs.symlinkSync(path.join(root, "releases", "aaa111"), path.join(root, "current"));
  assert.equal(resolveReleaseDir(undefined, root)?.id, "aaa111");
  // simulate a deploy: no restart needed
  fs.unlinkSync(path.join(root, "current"));
  fs.symlinkSync(path.join(root, "releases", "bbb222"), path.join(root, "current"));
  assert.equal(resolveReleaseDir(undefined, root)?.id, "bbb222");
  assert.equal(resolveReleaseDir("aaa111", root)?.id, "aaa111");
  assert.equal(resolveReleaseDir("missing", root), null);
  assert.equal(resolveReleaseDir("../x", root), null);
});
