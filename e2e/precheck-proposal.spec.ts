import { test, expect } from "@playwright/test";
import { precheckProposal } from "../src/lib/agents/fixes";

const f = ["src/a.ts"];

test("negated prose is allowed", () => {
  expect(precheckProposal({ files: f, proposed_change: "We cannot npm install left-pad here." }, true)).toBeNull();
  expect(precheckProposal({ files: f, proposed_change: "Tests were not run; no npm install lodash needed." }, true)).toBeNull();
});

test("ordinary prose about packages is allowed", () => {
  expect(precheckProposal({ files: f, proposed_change: "Adds a new package-level helper and a new dependency note in prose." }, true)).toBeNull();
});

test("real install command is blocked", () => {
  expect(precheckProposal({ files: f, proposed_change: "Run npm install zod to add validation." }, true)).toContain("cannot add dependencies");
});

test("manifest files are still blocked", () => {
  expect(precheckProposal({ files: ["package.json"], proposed_change: "tweak" }, true)).toContain("cannot edit");
});
