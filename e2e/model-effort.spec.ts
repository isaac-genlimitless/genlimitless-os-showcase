import { test as plain, expect as plainExpect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { test as isolated, expect } from "./isolated-test";
import { openTestDb } from "./db-handle";
import { MODELS, effortFor, modelFor, resolveModelEffort, validateModelEffort } from "../src/lib/model-policy";

// Per-task model + effort. Never presses Send and never starts an agent. The pure-logic and
// source checks run anywhere; the database checks only run on the isolated branch server.

plain("override beats agent default beats trigger rule beats global", () => {
  const opus = resolveModelEffort({ override: { model: "claude-opus-5-5", effort: "high" }, agentDefault: { model: "claude-haiku-4-5" }, trigger: "delegated", slug: "custom_helper" });
  plainExpect(opus).toEqual({ model: "claude-opus-5-5", effort: "high" });
  plainExpect(resolveModelEffort({ agentDefault: { model: "claude-haiku-4-5" }, trigger: "delegated", slug: "custom_helper" })).toEqual({ model: "claude-haiku-4-5" });
  plainExpect(resolveModelEffort({ trigger: "delegated", slug: "custom_helper" })).toEqual({ model: "claude-sonnet-5-5", effort: "medium" });
  plainExpect(resolveModelEffort({ trigger: "inbound_texts", slug: "custom_helper" })).toEqual({ model: "claude-sonnet-5-5", effort: "low" });
  plainExpect(resolveModelEffort({ trigger: "delegated", slug: "full_stack_engineer" }).effort).toBe("high");
  plainExpect(resolveModelEffort({ trigger: "event_prep", slug: "custom_helper" })).toEqual({ model: "claude-haiku-4-5" });
  plainExpect(modelFor("chat")).toBe("claude-sonnet-5-5");
  plainExpect(effortFor("triage", "chief_of_staff")).toBe("high");
});

plain("validation rejects bad values and accepts every table pair", () => {
  plainExpect(() => validateModelEffort("gpt-9")).toThrow(/Allowed models/);
  plainExpect(() => validateModelEffort("claude-sonnet-5-5", "max")).toThrow(/Allowed efforts/);
  plainExpect(() => validateModelEffort("claude-haiku-4-5", "low")).toThrow(/no effort setting/);
  for (const m of MODELS) {
    validateModelEffort(m.id);
    for (const e of m.efforts) validateModelEffort(m.id, e);
  }
});

plain("Haiku is refused for anything that drafts to outsiders", () => {
  for (const trigger of ["inbound_email", "inbound_texts", "inbound_sweep"]) plainExpect(() => resolveModelEffort({ override: { model: "claude-haiku-4-5" }, trigger, slug: "custom_helper" })).toThrow(/refused/);
  plainExpect(resolveModelEffort({ trigger: "event_prep", slug: "custom_helper" }).model).toBe("claude-haiku-4-5");
  plainExpect(resolveModelEffort({ override: { model: "claude-haiku-4-5" }, trigger: "delegated", slug: "status_lookup_agent" }).model).toBe("claude-haiku-4-5");
});

plain("delegate_to_agent declares optional model and effort from the shared enums", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/agents/tools.ts"), "utf8");
  const start = src.indexOf('"delegate_to_agent"');
  const block = src.slice(start, start + 2200);
  plainExpect(block).toMatch(/model: modelIdSchema\.optional\(\)/);
  plainExpect(block).toMatch(/effort: effortSchema\.optional\(\)/);
  plainExpect(/\bz\.(any|unknown|record)\(/.test(block)).toBe(false);
});

isolated("migration adds the columns; runs and agents store model/effort; bad defaults write nothing", async () => {
  const handle = openTestDb();
  try {
    const cols = (t: string) => (handle.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("agents")).toEqual(expect.arrayContaining(["default_model", "default_effort"]));
    expect(cols("agent_runs")).toEqual(expect.arrayContaining(["model", "effort"]));
  } finally {
    handle.close();
  }

  const { createAgent, updateAgent, agentChanges } = await import("../src/lib/agents/registry");
  const { startRun, getRun } = await import("../src/lib/agents/runs");
  const slug = `e2e_model_${Date.now().toString(36)}`;
  createAgent({ slug, name: "E2E model agent", objective: "test", responsibilities: "test", instructions: "", tools: [], created_by: "owner", reason: "e2e" });
  const before = (agentChanges(slug) as unknown[]).length;

  expect(() => updateAgent(slug, { default_model: "nope" }, "owner", "bad")).toThrow(/Unknown model/);
  expect(() => updateAgent(slug, { default_model: "claude-haiku-4-5", default_effort: "low" }, "owner", "bad")).toThrow();
  expect((agentChanges(slug) as unknown[]).length).toBe(before);

  const a = updateAgent(slug, { default_model: "claude-opus-5-5", default_effort: "high" }, "owner", "e2e");
  expect([a.default_model, a.default_effort]).toEqual(["claude-opus-5-5", "high"]);
  const rows = (agentChanges(slug) as { field: string; before: string | null; after: string }[]).filter((c) => c.field.startsWith("default_"));
  expect(rows.map((r) => r.after).sort()).toEqual(["claude-opus-5-5", "high"]);

  const id = startRun(slug, "delegated", "e2e", null, null, "claude-opus-5-5", "high");
  const run = getRun(id) as { model: string; effort: string };
  expect([run.model, run.effort]).toEqual(["claude-opus-5-5", "high"]);
});
