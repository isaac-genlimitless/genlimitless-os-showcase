"use client";

import { useState } from "react";

type Item = { action_id: number; label: string; conflict?: { label: string } | null };
type Cannot = { label: string; reason?: string };
type Preview = { status?: string; reversible?: Item[]; cannot?: Cannot[] };

export function UndoTurnButton({
  chatId,
  state,
  onChanged,
}: {
  chatId: number;
  state: "none" | "available" | "undone";
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<null | "undo" | "redo">(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [overwrite, setOverwrite] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state === "none") {
    return (
      <span className="text-xs text-muted mt-1 opacity-60" aria-disabled="true" data-testid="undo-none">
        Nothing to undo
      </span>
    );
  }

  async function start(action: "undo" | "redo") {
    setError(null);
    setOverwrite([]);
    setPreview(null);
    try {
      const r = await fetch(`/api/chat/undo?chat_id=${chatId}${action === "redo" ? "&action=redo" : ""}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "Could not load undo preview");
      setPreview(d);
      setOpen(action);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load undo preview");
    }
  }

  async function confirm() {
    if (!open) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/chat/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action: open, overwrite }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || "Failed");
      setOpen(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const reversible = preview?.reversible ?? [];
  const cannot = preview?.cannot ?? [];
  const running = preview?.status === "running";
  const verb = open === "redo" ? "Redo" : "Undo";

  return (
    <div className="mt-1 flex items-center gap-2 text-xs">
      {state === "available" ? (
        <button type="button" data-testid="undo-turn" onClick={() => start("undo")} className="text-xs text-muted hover:text-foreground">
          ↩︎ Undo
        </button>
      ) : (
        <>
          <span className="text-xs text-muted">Undone</span>
          <button type="button" data-testid="redo-turn" onClick={() => start("redo")} className="text-xs text-muted hover:text-foreground underline">
            Redo
          </button>
        </>
      )}
      {error && !open && <span className="text-red-500">{error}</span>}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div data-testid="undo-dialog" role="dialog" className="w-full max-w-md rounded-lg border border-panel-border bg-panel p-4 text-sm text-foreground">
            {running ? (
              <p>Still working on this reply; try again when it finishes</p>
            ) : (
              <>
                <p className="font-semibold mb-1">This will {open === "redo" ? "redo" : "reverse"}:</p>
                {reversible.length === 0 && <p className="text-muted">Nothing to {open}.</p>}
                <ul className="space-y-2">
                  {reversible.map((it) => (
                    <li key={it.action_id}>
                      <div>{it.label}</div>
                      {it.conflict && (
                        <label className="flex items-start gap-2 text-xs text-muted mt-1">
                          <input
                            type="checkbox"
                            checked={overwrite.includes(it.action_id)}
                            onChange={(e) =>
                              setOverwrite((o) => (e.target.checked ? [...o, it.action_id] : o.filter((x) => x !== it.action_id)))
                            }
                          />
                          <span>
                            ⚠ Changed again later by &lsquo;{it.conflict.label}&rsquo;. Leave as is (default) / Overwrite
                          </span>
                        </label>
                      )}
                    </li>
                  ))}
                </ul>
                {cannot.length > 0 && (
                  <>
                    <p className="font-semibold mt-3 mb-1">These can&apos;t be undone:</p>
                    <ul className="space-y-1 text-muted">
                      {cannot.map((c, i) => (
                        <li key={i}>
                          {c.label}
                          {c.reason ? ` (${c.reason})` : ""}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
            {error && <p className="mt-2 text-red-500">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(null)} className="px-3 py-1.5 rounded border border-panel-border">
                Cancel
              </button>
              {!running && (
                <button
                  type="button"
                  data-testid="undo-confirm"
                  disabled={busy || reversible.length === 0}
                  onClick={confirm}
                  className="px-3 py-1.5 rounded bg-gold text-black font-semibold disabled:opacity-50"
                >
                  {verb} {reversible.length} change{reversible.length === 1 ? "" : "s"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
