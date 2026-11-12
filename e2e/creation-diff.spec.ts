// Pure logic for The Creation's canon/sandbox model. No server, no database.
import { test, expect } from "@playwright/test";
import { applyChanges, diffArtifacts, rebaseArtifacts } from "../src/lib/creations/diff";
import type { Artifact } from "../src/lib/creations/types";

const a = (key: string, body: string, title = key): Artifact => ({ key, kind: "doc", title, body, data: null });

test("diff finds adds, changes and removes against the base", () => {
  const base = [a("vision", "v1"), a("location", "l1"), a("old", "x")];
  const sandbox = [a("vision", "v2"), a("location", "l1"), a("new", "n")];
  const ch = diffArtifacts(base, sandbox);
  expect(ch.map((c) => `${c.op}:${c.key}`).sort()).toEqual(["add:new", "change:vision", "remove:old"]);
});

test("a change is a conflict when canon moved on for that artifact", () => {
  const base = [a("vision", "v1"), a("location", "l1")];
  const sandbox = [a("vision", "mine"), a("location", "l1-edit")];
  const canonNow = [a("vision", "theirs"), a("location", "l1")];
  const ch = diffArtifacts(base, sandbox, canonNow);
  expect(ch.find((c) => c.key === "vision")?.conflict).toBe(true);
  expect(ch.find((c) => c.key === "location")?.conflict).toBeUndefined();
});

test("apply puts the sandbox's changes on top of the current canon without losing others' work", () => {
  const base = [a("vision", "v1"), a("location", "l1")];
  const sandbox = [a("vision", "v1"), a("location", "l2"), a("model", "m")];
  const canonNow = [a("vision", "v1-by-someone-else"), a("location", "l1")];
  const next = applyChanges(canonNow, diffArtifacts(base, sandbox));
  expect(next).toEqual([a("vision", "v1-by-someone-else"), a("location", "l2"), a("model", "m")]);
});

test("rebase pulls in canon's new content but keeps the sandbox's own edits", () => {
  const oldBase = [a("vision", "v1"), a("location", "l1")];
  const sandbox = [a("vision", "v1"), a("location", "mine")];
  const newBase = [a("vision", "v2"), a("location", "l1"), a("teardown", "t")];
  expect(rebaseArtifacts(oldBase, sandbox, newBase)).toEqual([a("vision", "v2"), a("location", "mine"), a("teardown", "t")]);
});
