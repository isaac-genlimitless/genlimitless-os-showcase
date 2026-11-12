import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { withAudit } from "../audit";
import { supersedeProposal } from "../proposal-lifecycle";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: (e as Error).message }], isError: true });
const AS_AGENT = { as_agent: z.string().optional().describe("Filled in automatically. Leave empty.") };

export const proposalLifecycleTools = [
  tool(
    "supersede_my_proposal",
    "Take one of your own pending proposals off Owner's /decisions list because it is outdated, wrong, or replaced: an email draft you wrote (kind 'email'), a text draft (kind 'text') or a proposed calendar block (kind 'calendar'). Needs the draft/block id and a reason. Only sets status to 'superseded' (the row is kept, nothing is deleted or sent) and logs your reason. Agents can supersede only email drafts they wrote; the Chief of Staff can supersede any pending email, text or calendar proposal. Use it when you replace a draft with a better one, when the moment has passed, or when the thread moved on. To discard something that is NOT a pending proposal, use request_owner_approval.",
    { kind: z.enum(["email", "text", "calendar"]), id: z.number(), reason: z.string().min(5), ...AS_AGENT },
    async ({ kind, id, reason, as_agent }: { kind: "email" | "text" | "calendar"; id: number; reason: string; as_agent?: string }) => {
      try {
        const by = as_agent || "agent";
        return json(await withAudit(`agent:${by}`, undefined, async () => supersedeProposal({ kind, id, reason, by })));
      } catch (e) {
        return fail(e);
      }
    }
  ),
];
