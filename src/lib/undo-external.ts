import { ownerName } from "./instance";
// Undo / Redo for calendar edits, mail organizing and Notion pages/properties (part 4).
// Non-destructive only: calendar edits are put back with no notifications, mail uses label changes,
// Notion properties are restored and a created page goes to Notion's Trash (restorable).
// All network modules are dynamic-imported so importing this file is free.

type Json = Record<string, any>;
export type ExtRow = { id: number; entity: string; entity_id: string | null; op: string; before_json: string | null; after_json: string | null; undoable: number; not_undoable_reason: string | null };
export type ExtConflict = { label: string; changed_by: string };
export const CAL_CREATE_REASON = "Removing an event is a cancellation, so it needs your approval. Cancel it in Calendar, or ask the assistant to request it";

const pj = (s: string | null): Json | null => {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((res) => {
    const t = setTimeout(() => res(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      () => {
        clearTimeout(t);
        res(undefined);
      }
    );
  });
}

// ---- calendar
const CAL_FIELDS = ["summary", "description", "start", "end", "status"];
const dateOnly = (s: unknown) => /^\d{4}-\d\d-\d\d$/.test(String(s ?? ""));
const sameVal = (k: string, a: unknown, b: unknown) => {
  if (k === "start" || k === "end") {
    const x = Date.parse(String(a ?? "")), y = Date.parse(String(b ?? ""));
    if (Number.isFinite(x) && Number.isFinite(y)) return x === y;
  }
  return String(a ?? "") === String(b ?? "");
};
const sameList = (a: string[] = [], b: string[] = []) =>
  JSON.stringify(a.map((s) => s.toLowerCase()).sort()) === JSON.stringify(b.map((s) => s.toLowerCase()).sort());

async function applyCalendar(r: ExtRow, target: Json, expected: Json) {
  const { getEvent, updateEvent, externalAttendees } = await import("./gcal");
  const account = String(expected.account ?? target.account);
  const cur = await getEvent(r.entity_id!, account);
  const patch: Json = {};
  for (const k of CAL_FIELDS) {
    if (sameVal(k, target[k], expected[k])) continue;
    if ((k === "start" || k === "end") && dateOnly(target[k])) throw new Error("Dates of all-day events can't be restored from chat");
    patch[k] = target[k] ?? "";
  }
  if (!sameList(target.attendees, expected.attendees)) {
    if ((await externalAttendees([...(target.attendees || []), ...(cur.attendees || [])])).length) throw new Error("Outside guests are on this event now; change it in Calendar");
    patch.attendees = target.attendees || [];
  }
  if (!Object.keys(patch).length) return;
  await updateEvent({ id: r.entity_id!, account, ...patch, sendUpdates: "none" }); // never notifies anyone
}

// ---- mail
type MS = { unread: boolean; starred: boolean; inbox: boolean; labeled: boolean };
const ATTR: Record<string, { attr: keyof MS; value: boolean }> = {
  mark_read: { attr: "unread", value: false },
  mark_unread: { attr: "unread", value: true },
  star: { attr: "starred", value: true },
  unstar: { attr: "starred", value: false },
  archive: { attr: "inbox", value: false },
  move_to_inbox: { attr: "inbox", value: true },
  add_label: { attr: "labeled", value: true },
  remove_label: { attr: "labeled", value: false },
};
const labelOps = (attr: keyof MS, value: boolean, label: string) => {
  const name = attr === "unread" ? "UNREAD" : attr === "starred" ? "STARRED" : attr === "inbox" ? "INBOX" : label;
  return value ? { add: [name] } : { remove: [name] };
};

// ---- sync check from recorded data only (no network): why this row can't be reversed, or null
export function externalCannot(r: ExtRow): string | null {
  const before = pj(r.before_json), after = pj(r.after_json);
  if (r.entity === "calendar_event") {
    if (r.op === "create") return CAL_CREATE_REASON;
    if (!before || !after || !after.start || !(after.account || before.account)) return "Not applied (waiting for your approval) or no before-state was recorded";
    if (String(before.recurrence ?? "") !== String(after.recurrence ?? "")) return "Repeat-rule changes can't be undone from chat";
    return null;
  }
  if (r.entity === "mail") {
    if (!after?.account || !ATTR[after.action]) return "Mail details weren't recorded";
    if (["add_label", "remove_label"].includes(after.action) && !after.label) return "Label name wasn't recorded";
    if (!before?.state || !Object.keys(before.state).length) return "The earlier state of these messages wasn't recorded";
    return null;
  }
  if (r.entity === "notion_page") {
    if (!r.entity_id) return "Page wasn't recorded";
    if (r.op === "create") return null;
    return before?.props ? null : "The earlier property values weren't recorded";
  }
  return "Can't be undone from chat";
}

// ---- live conflict check (network). Never throws.
export async function externalConflict(r: ExtRow, redo: boolean): Promise<ExtConflict | undefined> {
  const before = pj(r.before_json), after = pj(r.after_json);
  const changed = (label: string): ExtConflict => ({ label, changed_by: `${ownerName()} or another change` });
  try {
    if (r.entity === "calendar_event" && r.op !== "create") {
      const { getEvent } = await import("./gcal");
      const cur = await getEvent(r.entity_id!, String(after?.account ?? before?.account));
      const exp = (redo ? before : after) as Json;
      for (const k of CAL_FIELDS) if (!sameVal(k, cur[k as keyof typeof cur], exp[k])) return changed(`"${k}" was changed after the reply`);
      if (!sameList(cur.attendees, exp.attendees)) return changed("the guest list was changed after the reply");
    } else if (r.entity === "mail") {
      const { readMailState } = await import("./mail-accounts");
      const eff = ATTR[after!.action];
      const ids = Object.keys(before!.state).filter((id) => before!.state[id][eff.attr] !== eff.value);
      const cur = await readMailState(after!.account, ids, after!.label);
      const want = redo ? !eff.value : eff.value;
      if (ids.some((id) => cur[id]?.[eff.attr] !== want)) return changed("some messages were changed after the reply");
    } else if (r.entity === "notion_page" && r.op !== "create") {
      const { readWritableProperties } = await import("./notion");
      const exp = (redo ? before?.props : after?.props) as Json | null | undefined;
      if (!exp) return undefined;
      const cur = (await readWritableProperties(r.entity_id!, Object.keys(exp))).props;
      for (const k of Object.keys(exp)) if (JSON.stringify(cur[k]) !== JSON.stringify(exp[k])) return changed(`"${k}" was changed after the reply`);
    }
  } catch (e) {
    return { label: `couldn't check the current state (${(e as Error).message.slice(0, 80)})`, changed_by: "unknown" };
  }
  return undefined;
}

// ---- reverse / redo
export async function reverseExternal(r: ExtRow): Promise<void> {
  const before = pj(r.before_json), after = pj(r.after_json);
  if (r.entity === "calendar_event") {
    if (r.op === "create" || !before || !after) throw new Error(CAL_CREATE_REASON);
    return applyCalendar(r, before, after);
  }
  if (r.entity === "mail") {
    const { readMailState, changeMailLabels } = await import("./mail-accounts");
    const eff = ATTR[after!.action];
    const all = Object.keys(before!.state);
    const cur = await readMailState(after!.account, all, after!.label);
    const ids = all.filter((id) => before!.state[id][eff.attr] !== eff.value && cur[id]?.[eff.attr] === eff.value); // only what the AI changed and Owner hasn't touched since
    if (ids.length) await changeMailLabels(after!.account, ids, labelOps(eff.attr, !eff.value, after!.label));
    return;
  }
  if (r.entity === "notion_page") {
    const n = await import("./notion");
    if (!n.isOwned(r.entity_id!)) throw new Error("Not a page the OS created");
    if (r.op === "create") {
      await n.archiveNotionPage(r.entity_id!); // Notion Trash, restorable
      return;
    }
    await n.updateProperties(r.entity_id!, before!.props);
    return;
  }
  throw new Error(`Can't reverse ${r.entity}`);
}

export async function reapplyExternal(r: ExtRow): Promise<void> {
  const before = pj(r.before_json), after = pj(r.after_json);
  if (r.entity === "calendar_event" && r.op !== "create" && before && after) return applyCalendar(r, after, before);
  if (r.entity === "mail") {
    const { organizeMail } = await import("./mail-accounts");
    await organizeMail(after!.account, after!.message_ids, after!.action, after!.label ?? undefined);
    return;
  }
  if (r.entity === "notion_page") {
    const n = await import("./notion");
    if (!n.isOwned(r.entity_id!)) throw new Error("Not a page the OS created");
    if (r.op === "create") {
      await n.restoreNotionPage(r.entity_id!);
      return;
    }
    if (!after?.props) throw new Error("No after-state was recorded");
    await n.updateProperties(r.entity_id!, after.props);
    return;
  }
  throw new Error(`Can't redo ${r.entity}`);
}
