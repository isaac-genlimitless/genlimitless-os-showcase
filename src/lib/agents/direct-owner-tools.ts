import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import db from "../db";
import { notifyOwner } from "../delivery";
import { withAudit } from "../audit";
import { getAgent } from "./registry";

// Tools that let any agent reach Owner directly (main chat, or an immediate text). Neither has a
// recipient field: they can only ever reach Owner.

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: (e as Error).message }], isError: true });
const safe =
  <T,>(fn: (input: T) => unknown) =>
  async (input: T) => {
    try {
      return json(await withAudit(`agent:${(input as any)?.as_agent || "agent"}`, undefined, () => fn(input)));
    } catch (e) {
      return fail(e);
    }
  };
const AS_AGENT = { as_agent: z.string().optional().describe("Filled in automatically. Leave empty.") };

export const BRIDGE_DOWN_RE =
  /(mac|imessage|messages)[\s-]*(bridge|worker|sync)|bridge[\s-]*(offline|down|heartbeat|health)|mac (is )?(asleep|offline)/i;

const labelFor = (as_agent?: string) => getAgent(as_agent || "")?.name || as_agent || "Agent";

export function postAgentChatMessage({ message, as_agent }: { message: string; as_agent?: string }) {
  const text = (message || "").trim().slice(0, 2000);
  if (!text) throw new Error("message is empty");
  const r = db
    .prepare(`INSERT INTO chat_history (role, content) VALUES ('assistant', ?)`)
    .run(`**${labelFor(as_agent)}:** ${text}`);
  return { posted: true, id: Number(r.lastInsertRowid) };
}

export async function textOwnerNow({ message, reason, as_agent }: { message: string; reason: string; as_agent?: string }) {
  const text = (message || "").trim();
  if (!text) throw new Error("message is empty");
  if (text.length > 300) throw new Error("message must be under 300 characters; shorten it (or use message_owner_chat)");
  if (BRIDGE_DOWN_RE.test(text) || BRIDGE_DOWN_RE.test(reason || "")) {
    return {
      status: "refused",
      error: "Mac bridge downtime is never texted (Owner 10/24); it is logged as an issue automatically.",
    };
  }
  const label = labelFor(as_agent);
  const r = await notifyOwner({ message: `[${label}] ${text}`.slice(0, 300), reason: `${label}: ${reason}` });
  return { status: r.status, error: r.error };
}

export const directOwnerTools = [
  tool(
    "message_owner_chat",
    "Post a short message into Owner's main chat, labeled with your name. Use for updates, results, questions. Markdown links OK (e.g. [PR #12](url)). Lead with the result, a few lines. Only reaches Owner.",
    { message: z.string(), ...AS_AGENT },
    safe((i: { message: string; as_agent?: string }) => postAgentChatMessage(i))
  ),
  tool(
    "text_owner_now",
    "Immediate iMessage to OWNER only (no recipient option). Under 300 chars, lead with the action. Same quiet rules as other alerts: max 1 per 10 min and 8 per day (throttled texts are not sent: use message_owner_chat). Never for Mac bridge downtime. Critical/time-sensitive only.",
    { message: z.string().max(300), reason: z.string(), ...AS_AGENT },
    safe((i: { message: string; reason: string; as_agent?: string }) => textOwnerNow(i))
  ),
];
