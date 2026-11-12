"use client";

import { useState } from "react";

export default function TaskDeleteButton({ id, title, onRemoved, onError }: { id: number; title: string; onRemoved: () => void; onError: (m: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      const r = await fetch(`/api/tasks/${id}/remove`, { method: "POST" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        onError(d.error || `Delete failed (${r.status})`);
        return;
      }
      setConfirming(false);
      onRemoved();
    } catch {
      onError("Delete failed");
    } finally {
      setBusy(false);
    }
  }

  const btn = "text-xs text-muted max-md:text-sm max-md:px-3 max-md:-my-2.5 max-md:border max-md:border-panel-border max-md:rounded max-md:min-h-11";

  if (!confirming) {
    return (
      <button data-testid="task-delete" aria-label={`Delete task: ${title}`} className={`${btn} hover:text-danger`} onClick={() => setConfirming(true)}>
        Delete
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2 text-xs max-md:text-sm">
      <span className="text-danger">Delete this task?</span>
      <button data-testid="task-delete-confirm" disabled={busy} className={`${btn} hover:text-danger disabled:opacity-50`} onClick={remove}>
        Yes, delete
      </button>
      <button data-testid="task-delete-cancel" className={`${btn} hover:text-foreground`} onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  );
}
