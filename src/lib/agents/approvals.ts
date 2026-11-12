import { appendToPage, archiveNotionPage, updateProperties } from "../notion";
import { getApprovalRequest, markApprovalDecided } from "./registry";
import { rejectTextDraft } from "../text-drafts";
import { discardEmailDraft } from "../email-drafts";
import { trashMail } from "../mail-accounts";
import { cancelEvent, createEvent, updateEvent } from "../gcal";
import { archivePage } from "../pages";
import { applyScheduledTextCancel } from "../scheduled-texts";
import { applyTaskDelete } from "../task-delete";
import { setStatus, changeRole, removeUser, recordAdminAudit } from "../accounts/admin";
import { currentUserId } from "../accounts/identity";

function userAudit(action: string, p: { user_id: string; requested_by?: string }) {
  try { recordAdminAudit(currentUserId(), `${action}.approved`, p.user_id, `approved by Owner, requested by ${p.requested_by || "agent"}`); } catch { /* best-effort */ }
}

// Owner's decision on something an agent wasn't allowed to do alone. Approve runs exactly the
// action described in the request's payload, nothing else. Decline just records the answer.

export async function decideApproval(id: number, decision: "approve" | "decline") {
  const r = getApprovalRequest(id);
  if (!r || r.status !== "pending") throw new Error("That request isn't pending");
  if (decision === "decline") {
    markApprovalDecided(id, "declined");
    return { ok: true, status: "declined" };
  }
  const p = r.payload ? JSON.parse(r.payload) : {};
  try {
    let result: unknown = "done";
    switch (r.action) {
      case "discard_text_draft":
        if (r.target_id) rejectTextDraft(r.target_id);
        break;
      case "discard_email_draft":
        if (r.target_id) discardEmailDraft(r.target_id);
        break;
      case "trash_mail":
        result = await trashMail(p.account, p.message_ids);
        break;
      case "calendar_create":
        // Approved means the guests should actually get the invite.
        result = await createEvent({ ...p, sendUpdates: "all" });
        break;
      case "calendar_update":
        result = await updateEvent({ ...p, sendUpdates: "all", allowRuleChange: true });
        break;
      case "calendar_cancel":
        result = await cancelEvent(p.id, p.account, p.notify_guests ? "all" : "none");
        break;
      case "archive_page":
        if (r.target_id) result = archivePage(r.target_id); // soft: to the Trash, restorable
        break;
      case "notion_edit":
        result = p.op === "append" ? await appendToPage(p.page, p.markdown) : await updateProperties(p.page, p.properties);
        break;
      case "notion_archive":
        result = await archiveNotionPage(p.page); // Notion's Trash, restorable for 30 days
        break;
      case "cancel_scheduled_text":
        result = applyScheduledTextCancel(p.id, p.reason); // soft: row kept, status 'cancelled'
        break;
      case "delete_task":
        result = await applyTaskDelete(p.task_ids || (r.target_id ? [r.target_id] : [])); // soft: archived_at
        break;
      case "deactivate_user":
        result = setStatus(currentUserId(), p.user_id, "disabled"); // soft: restorable
        userAudit(r.action, p);
        break;
      case "change_user_role":
        result = changeRole(currentUserId(), p.user_id, p.role);
        userAudit(r.action, p);
        break;
      case "remove_user":
        result = removeUser(currentUserId(), p.user_id); // soft: removed_at, restorable in Users tab
        userAudit(r.action, p);
        break;
      case "other":
        break; // informational: the agent sees it approved and proceeds
    }
    markApprovalDecided(id, "approved", JSON.stringify(result).slice(0, 2000));
    return { ok: true, status: "approved", result };
  } catch (err: any) {
    markApprovalDecided(id, "failed", err.message);
    throw err;
  }
}
