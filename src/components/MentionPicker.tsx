"use client";

import { useEffect, useRef, useState } from "react";
import { mentionDisplayTitle } from "@/lib/mention-items";

// The "@" picker above the chat box. ChatPanel owns the textarea, the open/closed state and the
// keys (ArrowUp/Down, Enter/Tab select, Escape closes), so Enter while this is open is handled
// there BEFORE the send branch and can never send. Items come from the read-only /api/mentions
// route (Owner's own pages/files, meetings and tasks). Chief is always first.

export type PickerEntry = {
  key: string;
  label: string; // text inserted after the @
  href: string | null; // null = plain "@Chief"
  title: string;
  subtitle: string;
};

const CHIEF: PickerEntry = { key: "chief", label: "Chief", href: null, title: "Chief", subtitle: "Ask Chief to do something" };

const TYPE_LABEL: Record<string, string> = { page: "Page", meeting: "Meeting", task: "Task" };
const TYPE_ICON: Record<string, string> = { page: "📄", meeting: "🎙️", task: "✅" };

export function MentionPicker({
  query,
  active,
  onEntries,
  onPick,
  onHover,
}: {
  query: string;
  active: number;
  onEntries: (entries: PickerEntry[]) => void;
  onPick: (entry: PickerEntry) => void;
  onHover: (index: number) => void;
}) {
  const [entries, setEntries] = useState<PickerEntry[]>([CHIEF]);
  const listRef = useRef<HTMLDivElement>(null);
  const report = useRef(onEntries);
  report.current = onEntries;

  useEffect(() => {
    const base = "chief".startsWith(query.toLowerCase()) ? [CHIEF] : [];
    setEntries(base);
    report.current(base);
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/mentions?q=${encodeURIComponent(query)}`, { signal: ctl.signal });
        if (!res.ok) return;
        const d = await res.json();
        const items: PickerEntry[] = (d.items || []).map((it: any) => ({
          key: `${it.type}:${it.id}`,
          label:
            String(it.title ?? "").replace(/[\[\]()\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) ||
            `${TYPE_LABEL[it.type] || "Item"} ${it.id}`,
          href: String(it.url),
          title: mentionDisplayTitle(it),
          subtitle: `${TYPE_ICON[it.type] || "🔗"} ${TYPE_LABEL[it.type] || "Item"} · ${String(it.updated_at || "").slice(0, 10)}`,
        }));
        const all = [...base, ...items];
        setEntries(all);
        report.current(all);
      } catch {
        /* aborted or offline: keep what is shown */
      }
    }, 120);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, entries]);

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Tag something with @"
      data-testid="mention-picker"
      className="absolute bottom-full left-0 right-0 mb-2 z-30 max-h-64 overflow-y-auto rounded-lg border border-panel-border bg-panel shadow-lg text-sm"
    >
      {entries.map((e, i) => (
        <div
          key={e.key}
          role="option"
          aria-selected={i === active}
          data-testid="mention-option"
          data-index={i}
          onMouseDown={(ev) => {
            ev.preventDefault(); // keep focus (and the caret) in the textarea
            onPick(e);
          }}
          onMouseEnter={() => onHover(i)}
          className={`px-3 py-2 cursor-pointer ${i === active ? "bg-gold text-black" : "hover:bg-panel-border"}`}
        >
          <div className="font-medium truncate">@{e.title}</div>
          <div className={`text-xs truncate ${i === active ? "text-black/70" : "opacity-60"}`}>{e.subtitle}</div>
        </div>
      ))}
      <div className="px-3 py-2 text-xs opacity-60">Pages, files, meetings and tasks can be tagged. Others aren&apos;t linkable yet.</div>
    </div>
  );
}
