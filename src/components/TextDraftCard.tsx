"use client";

import { useEffect, useState } from "react";

type TextDraft = {
  id: number;
  to_handle: string | null;
  chat_guid: string | null;
  contact_name: string | null;
  text: string;
  status: string;
  approved_by: string | null;
};

// A text draft posted into chat (meta.type "text_draft"): edit, Approve & Send, or Reject right
// here. Replaces the old Communications → Text Drafts tab. Nothing sends until Approve.
export function TextDraftCard({ id }: { id: number }) {
  const [draft, setDraft] = useState<TextDraft | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const d = await fetch(`/api/text-drafts?id=${id}`).then((r) => r.json()).catch(() => null);
    if (d?.draft) {
      setDraft(d.draft);
      setText(d.draft.text);
    } else setError("This draft no longer exists.");
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function act(action: "approve" | "reject" | "edit") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/text-drafts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft_id: id, action, edited_text: text }),
      });
      const d = await res.json();
      if (!res.ok) setError(d.error || "Something went wrong.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!draft) return error ? <div className="mt-3 text-xs text-muted">{error}</div> : null;

  const pending = draft.status === "pending_approval";
  const who = draft.contact_name || draft.to_handle || draft.chat_guid?.split(";-;")[1] || "Group chat";
  return (
    <div className="mt-3 border border-panel-border rounded-lg p-3 bg-wash-1" data-testid="text-draft-card">
      <div className="flex items-center justify-between text-xs text-muted mb-2">
        <span>
          To <span className="text-foreground font-medium">{who}</span> · from your iMessage
        </span>
        {!pending && (
          <span className={draft.status === "sent" ? "text-success" : ""}>
            {draft.status === "cancelled" ? "rejected" : draft.approved_by === "agent_auto" ? "auto-sent" : draft.status}
          </span>
        )}
      </div>
      {pending ? (
        <>
          <textarea
            data-testid="text-draft-body"
            className="w-full bg-wash-2 border border-panel-border rounded p-2 text-sm min-h-20"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex gap-2 mt-2">
            <button
              data-testid="text-draft-approve"
              disabled={busy}
              onClick={() => act("approve")}
              className="bg-gold text-black text-xs font-semibold px-3 py-1.5 rounded hover:bg-gold-soft disabled:opacity-50"
            >
              Approve &amp; Send
            </button>
            <button
              data-testid="text-draft-save"
              disabled={busy || text === draft.text}
              onClick={() => act("edit")}
              className="border border-panel-border text-xs px-3 py-1.5 rounded hover:border-gold disabled:opacity-50"
            >
              Save edit
            </button>
            <button
              data-testid="text-draft-reject"
              disabled={busy}
              onClick={() => act("reject")}
              className="border border-panel-border text-xs px-3 py-1.5 rounded hover:border-gold disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </>
      ) : (
        <div className="text-sm whitespace-pre-wrap">{draft.text}</div>
      )}
      {error && <div className="mt-2 text-xs text-danger">{error}</div>}
    </div>
  );
}
