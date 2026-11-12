import { z } from "zod";

// Single source of truth for which model and effort an agent run uses.
// Precedence: explicit override (hand-off or chat box) > the agent's own default > trigger rules > global default.
// No database imports here on purpose: the chat UI and the tests use this file too.

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export type ModelTier = "cheap" | "standard" | "strong";

export const MODELS = [
  { id: "claude-haiku-4-5", label: "Haiku 4.5", tier: "cheap" as ModelTier, efforts: [] as readonly Effort[] },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", tier: "standard" as ModelTier, efforts: EFFORTS as readonly Effort[] },
  { id: "claude-opus-5-5", label: "Opus 5.5", tier: "strong" as ModelTier, efforts: EFFORTS as readonly Effort[] },
  { id: "claude-fable-5-1", label: "Fable 5.1", tier: "standard" as ModelTier, efforts: EFFORTS as readonly Effort[] },
] as const;

export const MODEL_IDS = MODELS.map((m) => m.id) as unknown as [string, ...string[]];
export const modelIdSchema = z.enum(MODEL_IDS as unknown as ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]);
export const effortSchema = z.enum(EFFORTS);

export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const CHEAP_MODEL = "claude-haiku-4-5";
const CHEAP_TRIGGERS = new Set(["event_prep"]);
const LOW_EFFORT_TRIGGERS = new Set(["inbound_texts"]);

// Anything that drafts to outsiders stays off Haiku: it read UTC as local for a time sent to someone else.
export const OUTSIDER_DRAFTING = new Set(["inbound_email", "inbound_texts", "inbound_sweep"]);

export const modelFor = (trigger: string) => (CHEAP_TRIGGERS.has(trigger) ? CHEAP_MODEL : DEFAULT_MODEL);

// Default effort is high for code work and triage; low for inbound texts; medium otherwise.
export function effortFor(trigger: string, slug: string): Effort {
  if (LOW_EFFORT_TRIGGERS.has(trigger)) return "low";
  if (slug === "full_stack_engineer" || trigger === "triage") return "high";
  return "medium";
}

export const modelInfo = (id: string) => MODELS.find((m) => m.id === id);
export const supportsEffort = (id: string) => (modelInfo(id)?.efforts.length ?? 0) > 0;

const allowedText = () =>
  `Allowed models: ${MODELS.map((m) => m.id).join(", ")}. Allowed efforts: ${EFFORTS.join(", ")} (${MODELS.filter((m) => !m.efforts.length).map((m) => m.label).join(", ")} has no effort setting).`;

/** Throws a plain error when the pair isn't allowed. Undefined values are fine (= not set). */
export function validateModelEffort(model?: string | null, effort?: string | null) {
  if (model != null && model !== "" && !modelInfo(model)) throw new Error(`Unknown model '${model}'. ${allowedText()}`);
  if (effort != null && effort !== "" && !(EFFORTS as readonly string[]).includes(effort)) throw new Error(`Unknown effort '${effort}'. ${allowedText()}`);
  if (model && effort && !supportsEffort(model)) throw new Error(`${modelInfo(model)!.label} has no effort setting; leave effort empty. ${allowedText()}`);
}

/** Haiku is refused for runs that draft to outsiders (agents and triggers in OUTSIDER_DRAFTING). */
export function assertModelAllowed(model: string, slug: string, trigger: string) {
  if (model === CHEAP_MODEL && (OUTSIDER_DRAFTING.has(slug) || OUTSIDER_DRAFTING.has(trigger)))
    throw new Error(`Haiku 4.5 is refused for '${slug}' (${trigger}): it drafts to outsiders and Haiku misread UTC for a time sent to someone else. Use claude-sonnet-5-5 or claude-opus-5-5.`);
}

export function resolveModelEffort(a: {
  override?: { model?: string | null; effort?: string | null };
  agentDefault?: { model?: string | null; effort?: string | null };
  trigger: string;
  slug: string;
}): { model: string; effort?: Effort } {
  const o = a.override || {};
  const d = a.agentDefault || {};
  const explicit = o.model || d.model;
  const model = explicit || modelFor(a.trigger);
  if (explicit) assertModelAllowed(model, a.slug, a.trigger);
  if (!supportsEffort(model)) return { model };
  const effort = (o.effort || d.effort || effortFor(a.trigger, a.slug)) as Effort;
  return { model, effort };
}

export const MODEL_GUIDANCE = `Pick the cheapest model/effort that does the job:
- Easy (inbox triage, status lookups, reformatting): claude-haiku-4-5 (no effort), or claude-sonnet-5-5 with effort low.
- Normal: claude-sonnet-5-5, medium (the default; leave model/effort out).
- Hard (strategy, code review, resumes, multi-step research): claude-opus-5-5, high.
Never choose Haiku for anything that drafts to outsiders (inbound email, texts or the inbound sweep).`;
