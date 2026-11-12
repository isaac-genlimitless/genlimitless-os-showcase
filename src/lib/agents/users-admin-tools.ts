import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { withAudit } from "../audit";
import { currentUserId } from "../accounts/identity";
import { listUsers, updateUser, setStatus, recordAdminAudit } from "../accounts/admin";
import { createApprovalRequest } from "./registry";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: (e as Error).message }], isError: true });
const AS_AGENT = { as_agent: z.string().optional().describe("Filled in automatically. Leave empty.") };

const audited = <T,>(by: string, fn: () => Promise<T>) => withAudit(`agent:${by}`, undefined, fn);
const allowed = (by: string) => {
  if (by !== "chief_of_staff" && by !== "full_stack_engineer") throw new Error("Only the Chief of Staff and the Full Stack Engineer can manage users.");
};

const approvalFor = (by: string, action: "deactivate_user" | "change_user_role" | "remove_user", id: string, label: string, reason: string, extra: Record<string, unknown> = {}) => {
  const who = listUsers(currentUserId(), { includeRemoved: true }).find((u) => u.id === id);
  if (!who) throw new Error("not_found");
  const r = createApprovalRequest({
    requested_by: by,
    action,
    title: `${label} user ${who.display_name} (${id})`,
    reason,
    payload: { user_id: id, requested_by: by, ...extra },
  });
  try { recordAdminAudit(currentUserId(), "user.request", id, { action, requested_by: by, ...extra }); } catch { /* audit best-effort */ }
  return r;
};

export const usersAdminTools = [
  tool(
    "list_users",
    "Read-only. List the OS users (id, name, email, phone, role, status, last active). Safe fields only; never credentials. Removed users are hidden unless include_removed is true.",
    { include_removed: z.boolean().optional(), ...AS_AGENT },
    async ({ include_removed, as_agent }: { include_removed?: boolean; as_agent?: string }) => {
      try {
        const by = as_agent || "agent";
        allowed(by);
        return json(await audited(by, async () => listUsers(currentUserId(), { includeRemoved: !!include_removed })));
      } catch (e) { return fail(e); }
    },
    { annotations: { readOnlyHint: true } }
  ),
  tool(
    "update_user",
    "Edit a user's display_name, email or phone directly (audited). Does not change role or status.",
    { id: z.string().min(1), display_name: z.string().optional(), email: z.string().nullable().optional(), phone: z.string().nullable().optional(), ...AS_AGENT },
    async ({ id, display_name, email, phone, as_agent }: { id: string; display_name?: string; email?: string | null; phone?: string | null; as_agent?: string }) => {
      try {
        const by = as_agent || "agent";
        allowed(by);
        return json(await audited(by, async () => {
          const patch: { display_name?: string; email?: string | null; phone?: string | null } = {};
          if (display_name !== undefined) patch.display_name = display_name;
          if (email !== undefined) patch.email = email;
          if (phone !== undefined) patch.phone = phone;
          const actor = currentUserId();
          const u = updateUser(actor, id, patch);
          try { recordAdminAudit(actor, "user.update.agent", id, { requested_by: by, fields: Object.keys(patch) }); } catch { /* best-effort */ }
          return u;
        }));
      } catch (e) { return fail(e); }
    }
  ),
  tool(
    "set_user_status",
    "Set a user's status. 'active' (reactivate) happens directly. 'disabled' (deactivate, signs them out) files an approval request for Owner and changes nothing until he approves. Needs a reason.",
    { id: z.string().min(1), status: z.enum(["active", "disabled"]), reason: z.string().min(5), ...AS_AGENT },
    async ({ id, status, reason, as_agent }: { id: string; status: "active" | "disabled"; reason: string; as_agent?: string }) => {
      try {
        const by = as_agent || "agent";
        allowed(by);
        return json(await audited(by, async () => {
          if (status === "active") {
            const actor = currentUserId();
            const u = setStatus(actor, id, "active");
            try { recordAdminAudit(actor, "user.reactivate.agent", id, { requested_by: by, reason }); } catch { /* best-effort */ }
            return u;
          }
          return approvalFor(by, "deactivate_user", id, "Deactivate", reason.trim());
        }));
      } catch (e) { return fail(e); }
    }
  ),
  tool(
    "change_user_role",
    "Request a role change (owner = Admin, member = Member) for a user. Always files an approval request for Owner; nothing changes until he approves.",
    { id: z.string().min(1), role: z.enum(["owner", "member"]), reason: z.string().min(5), ...AS_AGENT },
    async ({ id, role, reason, as_agent }: { id: string; role: "owner" | "member"; reason: string; as_agent?: string }) => {
      try {
        const by = as_agent || "agent";
        allowed(by);
        return json(await audited(by, async () => approvalFor(by, "change_user_role", id, `Make ${role}:`, reason.trim(), { role })));
      } catch (e) { return fail(e); }
    }
  ),
  tool(
    "remove_user",
    "Request removal of a user. Always files an approval request for Owner. Removal is soft: the user is disabled and hidden, data kept, and Owner can restore them in the Users tab. Admins cannot be removed. Needs a reason of at least 5 characters.",
    { id: z.string().min(1), reason: z.string().min(5), ...AS_AGENT },
    async ({ id, reason, as_agent }: { id: string; reason: string; as_agent?: string }) => {
      try {
        const by = as_agent || "agent";
        allowed(by);
        return json(await audited(by, async () => approvalFor(by, "remove_user", id, "Remove", reason.trim())));
      } catch (e) { return fail(e); }
    }
  ),
];
