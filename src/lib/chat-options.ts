// What Owner can pick in the chat box: which model answers, and how hard it thinks.
// Shared by the chat UI and /api/chat (which only accepts values listed here).
// "" = the OS default (Sonnet at medium effort, see agents/runtime.ts).

import { CHEAP_MODEL, EFFORTS, MODELS } from "./model-policy";

const MODEL_LABEL: Record<string, string> = {
  "claude-haiku-4-5": "Haiku 4.5 · fastest",
  "claude-opus-5-5": "Opus 5.5 · smartest",
};

export const CHAT_MODELS: readonly { id: string; label: string }[] = [
  { id: "", label: "Default (Sonnet 5.5)" },
  ...MODELS.map((m) => ({ id: m.id, label: MODEL_LABEL[m.id] ?? m.label })),
];

export const CHAT_EFFORTS: readonly { id: string; label: string }[] = [
  { id: "", label: "Default effort" },
  ...EFFORTS.map((e) => ({ id: e, label: `${e[0].toUpperCase()}${e.slice(1)} effort` })),
];

export type ChatEffort = "low" | "medium" | "high";

// Haiku 4.5 has no effort setting.
export const NO_EFFORT_MODEL = CHEAP_MODEL;

export function chatModel(v: unknown): string | undefined {
  return CHAT_MODELS.find((m) => m.id && m.id === v)?.id;
}

export function chatEffort(v: unknown): ChatEffort | undefined {
  return CHAT_EFFORTS.find((e) => e.id && e.id === v)?.id as ChatEffort | undefined;
}
