"use client";
// The Creation's home: every creation as a card, plus "start a new one".
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PHASES, type CreationSummary } from "@/lib/creations/types";

export default function CreationsHome({ apiBase = "/api/creations", linkBase = "/the-creation", canCreate = true }: {
  apiBase?: string;
  linkBase?: string;
  canCreate?: boolean;
}) {
  const router = useRouter();
  const [list, setList] = useState<CreationSummary[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [tagline, setTagline] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(apiBase).then(async (r) => {
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Couldn't load creations.");
      setList(d.creations);
    }).catch((e) => setError(e.message));
  }, [apiBase]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const r = await fetch(apiBase, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, tagline }) });
    const d = await r.json();
    setBusy(false);
    if (!r.ok) return setError(d.error || "Couldn't create it.");
    router.push(`${linkBase}/${d.creation.slug}`);
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" data-testid="creations-home">
      <div className="max-w-6xl mx-auto px-4 md:px-12 pt-6 pb-32">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
          <p className="text-sm text-muted max-w-2xl">
            Where new things get invented from scratch. Each creation has a <b>canon</b> (the real thing) and <b>sandboxes</b> where anything can be built.
            Canon only changes when you approve a proposal.
          </p>
          {canCreate && <button data-testid="new-creation" onClick={() => setAdding((v) => !v)} className="hover-pill text-sm border border-panel-border rounded-lg px-3 py-1.5">
            {adding ? "Cancel" : "+ New creation"}
          </button>}
        </div>
        {adding && (
          <form onSubmit={create} className="mb-6 p-4 rounded-xl border border-panel-border bg-panel flex flex-col gap-2" data-testid="new-creation-form">
            <input autoFocus required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What are you creating? (e.g. A revolutionary kitchen appliance)"
              className="bg-transparent border border-panel-border rounded-lg px-3 py-2 text-sm" data-testid="new-creation-title" />
            <input maxLength={400} value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="One line: why it should exist"
              className="bg-transparent border border-panel-border rounded-lg px-3 py-2 text-sm" />
            <div><button disabled={busy || !title.trim()} className="px-3 py-1.5 text-sm rounded-lg bg-accent text-background disabled:opacity-50" data-testid="new-creation-submit">Create</button></div>
          </form>
        )}
        {error && <div role="alert" className="text-sm text-danger mb-4">{error}</div>}
        {!list && !error && <div className="text-sm text-muted">Loading…</div>}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list?.map((c) => {
            const phase = PHASES.find((p) => p.key === c.phase);
            return (
              <Link key={c.id} href={`${linkBase}/${c.slug}`} data-testid={`creation-card-${c.slug}`}
                className="block p-5 rounded-xl border border-panel-border bg-panel hover:border-gold transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-3xl leading-none">{c.icon}</div>
                  {c.pending_promotions > 0 && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-gold-soft text-foreground" data-testid="pending-badge">{c.pending_promotions} to review</span>
                  )}
                </div>
                <h3 className="mt-3 font-semibold text-lg">{c.title}</h3>
                {c.tagline && <p className="mt-1 text-sm text-muted line-clamp-3">{c.tagline}</p>}
                <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                  <span>Phase: <span className="text-foreground">{phase?.label ?? c.phase}</span></span>
                  <span>Canon v{c.canon_version}</span>
                  <span>{c.artifact_count} artifact{c.artifact_count === 1 ? "" : "s"}</span>
                  {c.sandbox_count > 0 && <span>{c.sandbox_count} sandbox{c.sandbox_count === 1 ? "" : "es"}</span>}
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
