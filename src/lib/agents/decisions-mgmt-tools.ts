import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { withAudit } from "../audit";
import { listDecisions } from "../decisions";
import { editScheduleItem, getScheduleItem } from "../schedule";
import { listRetired, restoreProposal } from "../proposal-restore";
import { logActivity } from "./registry";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: (e as Error).message }], isError: true });
const AS_AGENT = { as_agent: z.string().optional().describe("Filled in automatically. Leave empty.") };

export const decisionsMgmtTools = [
  tool(
    "list_pending_decisions",
    "List everything waiting on Owner: this is exactly what he sees on /decisions (pending email drafts, text drafts, approval requests, proposed calendar blocks, code changes), with key, kind, id, title, detail, created_at and autopilot_send_at when Autopilot will send it, plus counts per kind. Read-only. Set include_retired to also list recently superseded/expired proposals (which can be put back with restore_proposal).",
    { include_retired: z.boolean().optional(), ...AS_AGENT },
    async ({ include_retired, as_agent }: { include_retired?: boolean; as_agent?: string }) => {
      try {
        return json(await withAudit(`agent:${as_agent || "agent"}`, undefined, async () => {
          const { items, counts } = listDecisions();
          return { items, counts, ...(include_retired ? { retired: listRetired() } : {}) };
        }));
      } catch (e) {
        return fail(e);
      }
    },
    { annotations: { readOnlyHint: true } }
  ),
  tool(
    "edit_calendar_proposal",
    "Change a PROPOSED calendar block (title, start, end, description or account) in place. Use this instead of superseding and re-proposing when only the time or title is wrong. Start/end must be ISO date-times and end must be after start. Only works while the block is still 'proposed'. Never approves it and never writes to any calendar; Owner still decides.",
    {
      id: z.number(),
      title: z.string().min(1).optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      description: z.string().optional(),
      account: z.string().optional(),
      ...AS_AGENT,
    },
    async (a: { id: number; title?: string; start?: string; end?: string; description?: string; account?: string; as_agent?: string }) => {
      try {
        const changes: Record<string, string> = {};
        for (const k of ["title", "start", "end", "description", "account"] as const) if (a[k] !== undefined) changes[k] = a[k] as string;
        if (!Object.keys(changes).length) throw new Error("Give at least one field to change (title, start, end, description or account)");
        for (const k of ["start", "end"] as const) if (changes[k] !== undefined && Number.isNaN(Date.parse(changes[k]))) throw new Error(`${k} is not a valid ISO date-time`);
        return json(await withAudit(`agent:${a.as_agent || "agent"}`, undefined, async () => {
          const cur = getScheduleItem(a.id);
          if (!cur) throw new Error("Schedule item not found");
          if (Date.parse(changes.end ?? cur.end) <= Date.parse(changes.start ?? cur.start)) throw new Error("end must be after start");
          return editScheduleItem(a.id, changes);
        }));
      } catch (e) {
        return fail(e);
      }
    }
  ),
  tool(
    "restore_proposal",
    "Chief of Staff only. Put a retired (superseded or expired) proposal back on Owner's /decisions list: kind 'email', 'text' or 'calendar', the id, and a reason (logged). Only works on retired rows, refuses if it would be retired again right away (e.g. a calendar block that already ended). Only sets status back to waiting for approval; never sends anything and never deletes.",
    { kind: z.enum(["email", "text", "calendar"]), id: z.number(), reason: z.string().min(5), ...AS_AGENT },
    async ({ kind, id, reason, as_agent }: { kind: "email" | "text" | "calendar"; id: number; reason: string; as_agent?: string }) => {
      try {
        const by = as_agent || "agent";
        if (by !== "chief_of_staff") throw new Error("Only the Chief of Staff can restore proposals; ask the Chief of Staff.");
        if ((reason || "").trim().length < 5) throw new Error("A reason of at least 5 characters is required");
        return json(await withAudit(`agent:${by}`, undefined, async () => {
          const res = restoreProposal({ kind, id, by });
          try { logActivity(by, "proposal_lifecycle", `Restore reason for ${kind} #${id}: ${reason.trim()}`); } catch { /* best-effort */ }
          return res;
        }));
      } catch (e) {
        return fail(e);
      }
    }
  ),
];
