import { query } from "@anthropic-ai/claude-agent-sdk";
import { LOCKED_BASE } from "./agent-lock";
import { nameFor } from "./instance";

// One-shot, tool-less text generation for background jobs (filing pages, meeting notes).
// Same lockdown as every agent: no tools at all, so untrusted page/transcript text can't do
// anything but influence the returned text.

export const FAST_MODEL = "claude-haiku-4-5-20251001";
export const SMART_MODEL = "claude-sonnet-5-5";

export async function generateText(prompt: string, model = FAST_MODEL): Promise<string> {
  const result = query({
    prompt: nameFor(prompt),
    options: { model, ...LOCKED_BASE, tools: [], allowedTools: [], maxTurns: 1 },
  });
  let out = "";
  for await (const message of result) {
    if (message.type === "result" && message.subtype === "success") out = message.result.trim();
  }
  if (!out) throw new Error("The model returned nothing");
  return out;
}

/** The first JSON object in a model reply (tolerates ```json fences and chatter around it). */
export function extractJson<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON in model reply");
  return JSON.parse(text.slice(start, end + 1)) as T;
}
