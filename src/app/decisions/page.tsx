"use client";
import { useOwnerName } from "@/components/CellContext";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { setOsContext } from "@/lib/os-context";
import RetiredProposals from "@/components/RetiredProposals";

// ONE queue of everything waiting on Owner. Each button calls the route that already owns that
// decision; nothing here has its own send path. Autopilot controls live at the bottom.

type Item = {
  key: string;
  kind: "email_draft" | "text_draft" | "approval" | "schedule_item" | "code_change";
  id: number;
  title: string;
  detail: string;
  created_at: string;
  autopilot_send_at?: string;
  autopilot_send_id?: number;
  autopilot_eligible?: { kind: "email" | "text"; recipient: string; label: string };
  link?: string;
};
type Trust = { id: number; kind: "email" | "text"; recipient: string; label: string | null; delay_min: number; status: string };
type Suggestion = { kind: "email" | "text"; recipient: string; label: string; approved_in_a_row: number };
type Send = { id: number; kind: string; draft_id: number; label: string | null; send_at: string; status: string; note: string | null };
type Panel = { paused: boolean; trusted: Trust[]; suggestions: Suggestion[]; scheduled: Send[]; recent: Send[] };

const KIND_LABEL: Record<Item["kind"], string> = {
  email_draft: "Email",
  text_draft: "Text",
  approval: "Approval",
  schedule_item: "Calendar",
  code_change: "Code",
};

function fmtUtc(s: string): string {
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return d.toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit" });
}

async function call(url: string, method: string, body: unknown) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

/** The owning route for each decision. Approve = Owner's click, exactly like the original card. */
function decide(item: Item, yes: boolean) {
  switch (item.kind) {
    case "email_draft":
      return call("/api/email-drafts", "PATCH", { id: item.id, action: yes ? "approve" : "discard" });
    case "text_draft":
      return call("/api/text-drafts", "PATCH", { draft_id: item.id, action: yes ? "approve" : "reject" });
    case "approval":
      return call("/api/agents", "POST", { action: "decide_approval", id: item.id, decision: yes ? "approve" : "decline" });
    case "schedule_item":
      return call("/api/schedule-items", "PATCH", { id: item.id, action: yes ? "approve" : "reject" });
    default:
      return Promise.reject(new Error("Review this one on its own page"));
  }
}

const YES_LABEL: Partial<Record<Item["kind"], string>> = { email_draft: "Send", text_draft: "Send", approval: "Approve", schedule_item: "Add to calendar" };
const NO_LABEL: Partial<Record<Item["kind"], string>> = { email_draft: "Discard", text_draft: "Reject", approval: "Decline", schedule_item: "Skip" };

export default function DecisionsPage() {
  const ownerName = useOwnerName();
  const [items, setItems] = useState<Item[] | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/decisions", { cache: "no-store" });
      const d = await r.json();
      setItems(d.items || []);
      setPanel(d.autopilot || null);
    } catch {
      setError("Couldn't load decisions.");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    setOsContext(`Decisions: ${items?.length ?? 0} waiting on ${ownerName}`, "decisions");
    return () => setOsContext(null, "decisions");
  }, [items?.length]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      await load();
    }
  }

  async function approveSelected() {
    const chosen = (items || []).filter((i) => selected.has(i.key) && YES_LABEL[i.kind]);
    if (!chosen.length) return;
    const sends = chosen.filter((i) => i.kind === "email_draft" || i.kind === "text_draft").length;
    if (!window.confirm(`Approve ${chosen.length} item${chosen.length === 1 ? "" : "s"}${sends ? ` (${sends} will be sent now)` : ""}?`)) return;
    await run("batch", async () => {
      const errors: string[] = [];
      for (const i of chosen) await decide(i, true).catch((e) => errors.push(`${i.title}: ${(e as Error).message}`));
      setSelected(new Set());
      if (errors.length) throw new Error(errors.join("; "));
    });
  }

  const autopilot = (body: Record<string, unknown>, key: string) => run(key, () => call("/api/autopilot", "POST", body));

  const list = items || [];
  const selectable = list.filter((i) => YES_LABEL[i.kind]);
  const onAutopilot = new Set((panel?.trusted || []).filter((t) => t.status === "active").map((t) => `${t.kind}:${t.recipient}`));

  return (
    <div className="p-8 max-md:p-4 space-y-8 max-md:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl tracking-wide">Decisions</h1>
          <p className="text-sm text-muted mt-1">Everything waiting on you, oldest first. Autopilot sends are on top because they&apos;re on a clock.</p>
        </div>
        {selectable.length > 1 && (
          <div className="flex items-center gap-2">
            <button
              className="px-3 py-1.5 text-sm rounded border border-panel-border text-muted max-md:min-h-11"
              onClick={() => setSelected(selected.size === selectable.length ? new Set() : new Set(selectable.map((i) => i.key)))}
            >
              {selected.size === selectable.length ? "Clear" : "Select all"}
            </button>
            <button data-testid="decisions-approve-selected" disabled={!selected.size || busy === "batch"} className="px-3 py-1.5 text-sm rounded bg-accent text-black disabled:opacity-40 max-md:min-h-11" onClick={approveSelected}>
              Approve selected{selected.size ? ` (${selected.size})` : ""}
            </button>
          </div>
        )}
      </div>

      {error && <div className="text-sm text-danger" role="alert">{error}</div>}

      <section aria-label="Waiting on you">
        {items === null ? (
          <div className="text-sm text-muted">Loading…</div>
        ) : list.length === 0 ? (
          <div data-testid="decisions-empty" className="text-sm text-muted px-4 py-6 bg-panel border border-panel-border rounded">Nothing is waiting on you. 🎉</div>
        ) : (
          <ul className="space-y-2" data-testid="decisions-list">
            {list.map((i) => (
              <li key={i.key} data-testid="decision-row" data-kind={i.kind} className="flex flex-wrap md:flex-nowrap items-start gap-3 px-4 py-3 bg-panel border border-panel-border rounded">
                {YES_LABEL[i.kind] ? (
                  <input
                    type="checkbox"
                    className="mt-1 accent-accent max-md:h-5 max-md:w-5"
                    aria-label={`Select ${i.title}`}
                    checked={selected.has(i.key)}
                    onChange={(e) => {
                      const n = new Set(selected);
                      if (e.target.checked) n.add(i.key);
                      else n.delete(i.key);
                      setSelected(n);
                    }}
                  />
                ) : (
                  <span className="w-[13px] max-md:w-5" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs px-2 py-0.5 rounded-full border border-panel-border text-muted">{KIND_LABEL[i.kind]}</span>
                    <span className="text-sm [overflow-wrap:anywhere]">{i.title}</span>
                  </div>
                  {i.detail && <div className="text-xs text-muted mt-1 [overflow-wrap:anywhere]">{i.detail}</div>}
                  {i.autopilot_send_at && (
                    <div className="text-xs mt-1 text-accent" data-testid="autopilot-countdown">
                      Autopilot sends {fmtUtc(i.autopilot_send_at)} unless you hold it.
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 max-md:basis-full max-md:pl-8 max-md:gap-3">
                  {i.autopilot_send_id && (
                    <button className="px-3 py-1 text-sm rounded border border-accent text-accent max-md:min-h-11 max-md:px-4" disabled={busy === i.key} onClick={() => autopilot({ action: "hold", id: i.autopilot_send_id }, i.key)}>
                      Hold
                    </button>
                  )}
                  {YES_LABEL[i.kind] ? (
                    <>
                      <button className="px-3 py-1 text-sm rounded bg-accent text-black max-md:min-h-11 max-md:px-4" disabled={busy === i.key} onClick={() => run(i.key, () => decide(i, true))}>
                        {YES_LABEL[i.kind]}
                      </button>
                      <button className="px-3 py-1 text-sm rounded border border-panel-border text-muted max-md:min-h-11 max-md:px-4" disabled={busy === i.key} onClick={() => run(i.key, () => decide(i, false))}>
                        {NO_LABEL[i.kind]}
                      </button>
                    </>
                  ) : (
                    <Link href={i.link || "/"} className="px-3 py-1 text-sm rounded border border-panel-border text-muted max-md:min-h-11 max-md:px-4 max-md:inline-flex max-md:items-center">
                      Review
                    </Link>
                  )}
                  {i.autopilot_eligible && !i.autopilot_send_at && !onAutopilot.has(`${i.autopilot_eligible.kind}:${i.autopilot_eligible.recipient}`) && (
                    <button
                      className="text-xs text-muted hover:text-foreground underline max-md:min-h-11 max-md:flex max-md:items-center"
                      title="Future drafts to this person send after a 30-minute hold window unless you stop them"
                      onClick={() => {
                        if (window.confirm(`Put ${i.autopilot_eligible!.label} on Autopilot? Future drafts to them will send after a 30-minute hold unless you stop them. This draft still waits for you.`))
                          autopilot({ action: "turn_on", kind: i.autopilot_eligible!.kind, recipient: i.autopilot_eligible!.recipient, label: i.autopilot_eligible!.label }, i.key);
                      }}
                    >
                      Autopilot this person
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Autopilot" data-testid="autopilot-panel" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-xl tracking-wide">Autopilot</h2>
            <p className="text-sm text-muted mt-1">
              People you trust Chief to reply to. Their drafts send after a hold window, only 7am–9pm, max 3 a day each and 10 a day total. Group chats never qualify.
            </p>
          </div>
          {panel && (
            <button
              data-testid="autopilot-pause"
              className={`px-3 py-1.5 text-sm rounded max-md:min-h-11 ${panel.paused ? "bg-accent text-black" : "border border-panel-border text-muted"}`}
              onClick={() => autopilot({ action: panel.paused ? "resume" : "pause" }, "pause")}
            >
              {panel.paused ? "Resume Autopilot" : "Pause all"}
            </button>
          )}
        </div>
        {panel?.paused && <div className="text-sm text-danger">Autopilot is paused. Nothing sends on its own until you resume.</div>}

        {!!panel?.suggestions.length && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Suggested by Chief</h3>
            {panel.suggestions.map((s) => (
              <div key={`${s.kind}:${s.recipient}`} data-testid="autopilot-suggestion" className="flex flex-wrap items-center gap-3 px-4 py-3 bg-panel border border-panel-border rounded">
                <div className="flex-1 min-w-0 text-sm">
                  You&apos;ve approved my last {s.approved_in_a_row} {s.kind === "email" ? "emails" : "texts"} to <b>{s.label}</b> without changing a word.
                </div>
                <button className="px-3 py-1 text-sm rounded bg-accent text-black max-md:min-h-11" onClick={() => autopilot({ action: "turn_on", kind: s.kind, recipient: s.recipient, label: s.label }, `s:${s.recipient}`)}>
                  Turn on
                </button>
                <button className="px-3 py-1 text-sm rounded border border-panel-border text-muted max-md:min-h-11" onClick={() => autopilot({ action: "decline", kind: s.kind, recipient: s.recipient, label: s.label }, `s:${s.recipient}`)}>
                  Not now
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">On Autopilot</h3>
          {!panel?.trusted.filter((t) => t.status === "active").length ? (
            <div className="text-sm text-muted">No one yet. Use &quot;Autopilot this person&quot; on a draft, or accept one of Chief&apos;s suggestions.</div>
          ) : (
            <ul className="space-y-2">
              {panel.trusted
                .filter((t) => t.status === "active")
                .map((t) => (
                  <li key={t.id} data-testid="autopilot-trusted" className="flex flex-wrap items-center gap-3 px-4 py-2 bg-panel border border-panel-border rounded text-sm">
                    <span className="flex-1 min-w-0">
                      {t.label || t.recipient} <span className="text-muted">· {t.kind} · {t.delay_min} min hold</span>
                    </span>
                    <button className="px-3 py-1 text-sm rounded border border-panel-border text-muted max-md:min-h-11" onClick={() => autopilot({ action: "turn_off", id: t.id }, `t:${t.id}`)}>
                      Turn off
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>

        {!!panel?.recent.length && (
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Recent</h3>
            {panel.recent.map((s) => (
              <div key={s.id} className="text-xs text-muted">
                {s.kind} to {s.label}: {s.status}
                {s.note ? `, ${s.note}` : ""}
              </div>
            ))}
          </div>
        )}
      </section>
      <RetiredProposals onChange={load} />
    </div>
  );
}
