import { ownerName } from "./instance";
import { runChiefOfStaff } from "./agents/runtime";

// Entry point into the agent team for Owner's chat. The agents themselves live in src/lib/agents/:
// the Chief of Staff runs the chat and delegates; scheduled and event-driven work goes straight to
// the agent that owns it.

export async function runAgent(
  history: { role: "user" | "assistant"; content: string }[],
  attachmentNote?: string,
  contextPrefix = "",
  thread?: string,
  pick: { model?: string; effort?: "low" | "medium" | "high"; onRunId?: (id: number) => void } = {}
): Promise<string> {
  // The SDK's query() is a single-shot prompt, not raw chat turns, so we fold the running
  // history into one prompt and let the Chief of Staff's loop (delegate -> check -> answer)
  // run to completion. Files on the latest turn are described by path so agents open them with Read.
  const transcript =
    contextPrefix +
    history.map((h) => `${h.role === "user" ? ownerName() : "You"}: ${h.content}`).join("\n\n") + (attachmentNote || "");
  const ask = [...history].reverse().find((h) => h.role === "user")?.content;
  const { onRunId, ...choice } = pick;
  return runChiefOfStaff(transcript, { thread, ask, ...choice, onStart: onRunId });
}
