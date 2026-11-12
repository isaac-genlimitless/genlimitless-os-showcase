"use client";

import { useCallback, useEffect, useState } from "react";

type Item = {
  id: number;
  title: string;
  source?: string;
  person?: string;
  date?: string;
  excerpt?: string;
  reasoning?: string;
};

const SOURCES: Record<string, string> = {
  text_sent: "Text you sent",
  text_received: "Text received",
  email_sent: "Email you sent",
  email_received: "Email received",
  calendar: "Calendar",
  draft_sent: "Draft sent",
  commitment_done: "Commitment done",
};

function normalize(json: any): Item[] {
  const list: any[] = Array.isArray(json) ? json : Array.isArray(json?.items) ? json.items : Array.isArray(json?.tasks) ? json.tasks : [];
  return list
    .map((r) => ({
      id: Number(r.task_id ?? r.id),
      title: String(r.title ?? r.task_title ?? ""),
      source: r.source ?? r.evidence_source,
      person: r.person,
      date: r.date ?? r.evidence_date,
      excerpt: r.excerpt,
      reasoning: r.reasoning,
    }))
    .filter((r) => Number.isFinite(r.id));
}

async function fetchView(view: string): Promise<Item[]> {
  try {
    const r = await fetch(`/api/task-evidence?view=${view}`, { cache: "no-store" });
    if (!r.ok) return [];
    return normalize(await r.json());
  } catch {
    return [];
  }
}

function Card({
  item,
  busy,
  error,
  children,
}: {
  item: Item;
  busy: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const chips = [item.source ? SOURCES[item.source] ?? item.source : "", item.person, item.date].filter(Boolean) as string[];
  return (
    <li
      data-testid={undefined}
      className="w-full border border-panel-border rounded p-3 space-y-2 text-sm"
      aria-busy={busy}
    >
      <div className="font-medium [overflow-wrap:anywhere]">{item.title}</div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map((c, i) => (
            <span key={i} className="text-sm px-2 py-0.5 rounded-full border border-panel-border text-muted [overflow-wrap:anywhere]">
              {c}
            </span>
          ))}
        </div>
      )}
      {item.excerpt && (
        <blockquote
          onClick={() => setOpen(!open)}
          className={`border-l-2 border-panel-border pl-2 text-sm [overflow-wrap:anywhere] cursor-pointer ${open ? "" : "line-clamp-4"}`}
        >
          {item.excerpt}
        </blockquote>
      )}
      {item.reasoning && <div className="text-sm text-muted [overflow-wrap:anywhere]">{item.reasoning}</div>}
      <div className="flex gap-2 w-full md:w-auto md:justify-start">{children}</div>
      {error && <div className="text-sm text-red-500 [overflow-wrap:anywhere]">{error}</div>}
    </li>
  );
}

export default function LikelyDoneSection({ onChanged }: { onChanged: () => void }) {
  const [likely, setLikely] = useState<Item[]>([]);
  const [closed, setClosed] = useState<Item[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [showClosed, setShowClosed] = useState(false);

  const reload = useCallback(async () => {
    const [a, b] = await Promise.all([fetchView("likely_done"), fetchView("auto_closed")]);
    setLikely(a);
    setClosed(b);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function act(id: number, action: "done" | "not_yet" | "revert") {
    setBusyId(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const r = await fetch(`/api/task-evidence/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!r.ok) throw new Error("failed");
      if (action === "revert") setClosed((c) => c.filter((x) => x.id !== id));
      else setLikely((l) => l.filter((x) => x.id !== id));
      await reload();
      onChanged();
    } catch {
      setErrors((e) => ({ ...e, [id]: "Couldn't save that. Try again." }));
    } finally {
      setBusyId(null);
    }
  }

  if (likely.length === 0 && closed.length === 0) return null;

  const btn = "flex-1 md:flex-none md:px-4 min-h-11 rounded border border-panel-border text-sm disabled:opacity-50";

  return (
    <div data-testid="likely-done-wrap" className="space-y-3 w-full">
      {likely.length > 0 && (
        <section data-testid="likely-done" className="space-y-2">
          <h2 className="text-sm text-muted uppercase tracking-wide">Likely done: confirm ({likely.length})</h2>
          <ul className="space-y-2">
            {likely.map((t) => (
              <div key={t.id} data-testid="likely-done-card" data-task-id={t.id}>
                <Card item={t} busy={busyId === t.id} error={errors[t.id]}>
                  <button data-testid="likely-done-yes" disabled={busyId === t.id} onClick={() => act(t.id, "done")} className={`${btn} text-accent border-accent`}>
                    Done
                  </button>
                  <button data-testid="likely-done-no" disabled={busyId === t.id} onClick={() => act(t.id, "not_yet")} className={btn}>
                    Not yet
                  </button>
                </Card>
              </div>
            ))}
          </ul>
        </section>
      )}
      {closed.length > 0 && (
        <section data-testid="auto-closed" className="space-y-2">
          <button className="text-sm text-muted min-h-11 text-left" onClick={() => setShowClosed(!showClosed)}>
            {showClosed ? "▾" : "▸"} Auto-closed by the OS in the last 7 days ({closed.length})
          </button>
          {showClosed && (
            <ul className="space-y-2">
              {closed.map((t) => (
                <div key={t.id} data-testid="auto-closed-card" data-task-id={t.id}>
                  <Card item={t} busy={busyId === t.id} error={errors[t.id]}>
                    <button data-testid="auto-closed-undo" disabled={busyId === t.id} onClick={() => act(t.id, "revert")} className={btn}>
                      Undo
                    </button>
                  </Card>
                </div>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
