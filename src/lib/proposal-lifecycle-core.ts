// Pure rules for retiring stale proposals. No imports, so node:test runs it without the database.
export type Conv = { id: number; address: string; subject: string; thread?: string | null; at: string }; // at = 'YYYY-MM-DD HH:MM:SS'

export const normSubject = (s: string | null | undefined) =>
  (s || "").toLowerCase().replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim();

export const bareAddress = (s: string | null | undefined) => {
  const m = (s || "").match(/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/);
  return (m ? m[0] : s || "").toLowerCase().trim();
};

/** Recipient key: last 10 digits for phones, lowercased otherwise; "any;-;+1801..." resolves to the handle; group guids stay whole. */
export function textKey(to_handle?: string | null, chat_guid?: string | null): string {
  const raw = to_handle || (chat_guid && chat_guid.includes(";-;") ? chat_guid.split(";-;")[1] : chat_guid) || "";
  if (!raw) return "";
  if (raw.includes("@")) return raw.toLowerCase().trim();
  const d = raw.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : raw.toLowerCase().trim();
}

/** Dead once the END time has passed; an unparseable end falls back to the Central date. */
export const hasEnded = (end: string, date: string, nowMs: number, todayKey: string) => {
  const t = Date.parse(end);
  return Number.isNaN(t) ? date < todayKey : t < nowMs;
};

/** Same Gmail thread id (when both have one) OR same bare address + same subject ignoring Re:/Fwd:. */
export function sameConversation(a: Conv, b: Conv): boolean {
  if (a.thread && b.thread) return a.thread === b.thread;
  return !!a.address && a.address === b.address && normSubject(a.subject) === normSubject(b.subject);
}

/** draft id -> why it is stale. later = newer pending drafts ("draft"), Owner's sent mail ("sent"), inbound mail ("inbound"). */
export function staleEmailReasons(
  pending: (Conv & { isReply: boolean })[],
  later: (Conv & { kind: "draft" | "sent" | "inbound" })[]
): Map<number, string> {
  const out = new Map<number, string>();
  for (const d of pending) {
    for (const e of later) {
      if (!sameConversation(d, e)) continue;
      if (e.kind === "draft" && e.id > d.id) { out.set(d.id, `a newer draft (#${e.id}) to the same recipient/thread exists`); break; }
      if (e.kind === "sent" && e.at > d.at) { out.set(d.id, `Owner already replied (email draft #${e.id} was sent after this one)`); break; }
      // Inbound mail only voids a draft that IS a reply; fresh outreach is untouched.
      if (e.kind === "inbound" && d.isReply && e.at > d.at) { out.set(d.id, "the other side sent a newer message on this thread after this draft"); break; }
    }
  }
  return out;
}

/** Older pending texts to the same person lose to the newest pending one, and to any text already sent to them since. */
export function staleTextReasons(pending: { id: number; key: string }[], sent: { id: number; key: string }[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const t of pending) {
    if (!t.key) continue;
    const newer = pending.filter((o) => o.key === t.key && o.id > t.id).sort((a, b) => b.id - a.id)[0];
    if (newer) { out.set(t.id, `a newer text draft (#${newer.id}) to the same person exists`); continue; }
    const s = sent.find((o) => o.key === t.key && o.id > t.id);
    if (s) out.set(t.id, `a newer text (#${s.id}) to the same person was already sent`);
  }
  return out;
}
