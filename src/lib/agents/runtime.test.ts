// Unit tests for per-run research limits. Never calls an agent or sends anything.
import test from "node:test";
import assert from "node:assert/strict";
import { researchLimits } from "./runtime";

test("research_strategist gets 30 searches", () => {
  assert.equal(researchLimits("research_strategist", "chat").searches, 30);
  assert.equal(researchLimits("research_strategist", "delegated").searches, 30);
});

test("other agents keep the default cap", () => {
  assert.equal(researchLimits("sales", "chat").searches, 10);
});

test("research_scout gets 40 searches and 60 page reads, on every trigger", () => {
  for (const trigger of ["chat", "delegated", "schedule"]) {
    const l = researchLimits("research_scout", trigger);
    assert.equal(l.searches, 40);
    assert.equal(l.pages, 60);
  }
});

test("other agents keep 10 searches and 25 page reads", () => {
  const s = researchLimits("sales", "chat");
  assert.equal(s.searches, 10);
  assert.equal(s.pages, 25);
  const j = researchLimits("research_strategist", "chat");
  assert.equal(j.searches, 30);
  assert.equal(j.pages, 25);
});
