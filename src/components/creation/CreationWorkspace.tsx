"use client";
// One creation: phase strip, canon/sandbox switcher, artifact list, the artifact, and the feed.
// Canon is read-only here. Everything is built in a sandbox and proposed back.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { setOsContext } from "@/lib/os-context";
import { PHASES, type Artifact, type CreationDetail, type SandboxDetail, type VersionRow } from "@/lib/creations/types";
import ArtifactView from "./ArtifactView";
import FeedPanel, { ChangeList } from "./FeedPanel";
import MembersPanel from "./MembersPanel";
import MissionsPanel from "./MissionsPanel";
import ExecutionBoard from "./ExecutionBoard";

async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d as T;
}

export default function CreationWorkspace({ slug, apiBase = "/api/creations", linkBase = "/the-creation" }: {
  slug: string;
  /** "/api/creations" for Owner, "/c/<token>/api/creations" for a collaborator. */
  apiBase?: string;
  linkBase?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const sandboxId = Number(params.get("sandbox")) || null;
  const versionId = Number(params.get("version")) || null;
  const [detail, setDetail] = useState<CreationDetail | null>(null);
  const [sandboxData, setSandbox] = useState<SandboxDetail | null>(null);
  const [versionData, setOldVersion] = useState<{ version: VersionRow; artifacts: Artifact[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(params.get("a"));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showPropose, setShowPropose] = useState(false);
  const [rationale, setRationale] = useState("");
  const [newArt, setNewArt] = useState("");

  const load = useCallback(
    () => api<CreationDetail>(`${apiBase}/${slug}`).then((d) => { setDetail(d); setError(""); }).catch((e) => setError(e.message)),
    [slug, apiBase],
  );
  const loadSandbox = useCallback(
    () => (sandboxId ? api<SandboxDetail>(`${apiBase}/sandboxes/${sandboxId}`).then(setSandbox).catch((e) => setError(e.message)) : Promise.resolve()),
    [sandboxId, apiBase],
  );

  useEffect(() => {
    api<CreationDetail>(`${apiBase}/${slug}`).then(setDetail).catch((e) => setError(e.message));
  }, [slug, apiBase]);
  useEffect(() => {
    if (sandboxId) api<SandboxDetail>(`${apiBase}/sandboxes/${sandboxId}`).then(setSandbox).catch((e) => setError(e.message));
  }, [sandboxId, apiBase]);
  useEffect(() => {
    if (versionId) api<{ version: VersionRow; artifacts: Artifact[] }>(`${apiBase}/versions/${versionId}`).then(setOldVersion).catch((e) => setError(e.message));
  }, [versionId, apiBase]);
  // Only show what matches the URL (stale responses from a previous view are ignored).
  const sandbox = sandboxData && sandboxData.sandbox.id === sandboxId ? sandboxData : null;
  const oldVersion = versionData && versionData.version.id === versionId ? versionData : null;

  const mode: "canon" | "sandbox" | "version" | "execution" =
    params.get("view") === "execution" ? "execution" : sandboxId ? "sandbox" : versionId ? "version" : "canon";
  // Small screens show the work OR the feed (wider screens show both).
  const [pane, setPane] = useState<"work" | "feed">("work");
  const artifacts = mode === "sandbox" ? sandbox?.artifacts : mode === "version" ? oldVersion?.artifacts : detail?.canon.artifacts;
  const current = useMemo(() => artifacts?.find((a) => a.key === selected) ?? artifacts?.[0] ?? null, [artifacts, selected]);
  const changedKeys = useMemo(() => new Set(sandbox?.changes.map((c) => c.key)), [sandbox]);

  useEffect(() => {
    if (!detail) return;
    const where = mode === "sandbox" && sandbox ? `sandbox "${sandbox.sandbox.title}" (id ${sandbox.sandbox.id}, editable, canon untouched)` : mode === "version" ? `old canon version` : `canon v${detail.canon.version.number} (read-only)`;
    setOsContext(`The Creation: "${detail.creation.title}" (/the-creation/${slug}), viewing ${where}${current ? `, artifact "${current.title}"` : ""}`);
    return () => setOsContext(null);
  }, [detail, sandbox, mode, current, slug]);

  const go = (q: Record<string, string | number | null>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== null && v !== "") sp.set(k, String(v));
    const s = sp.toString();
    router.push(`${linkBase}/${slug}${s ? `?${s}` : ""}`);
  };

  async function run(fn: () => Promise<unknown>, okMsg?: string) {
    setError("");
    setNotice("");
    try {
      await fn();
      if (okMsg) setNotice(okMsg);
      await Promise.all([load(), loadSandbox()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function newSandbox() {
    const me = detail ? detail.viewer[0].toUpperCase() + detail.viewer.slice(1) : "My";
    const title = window.prompt("Name this sandbox", `${me}'s sandbox`);
    if (title === null) return;
    try {
      const d = await api<{ sandbox: { id: number } }>(`${apiBase}/${slug}/sandboxes`, { method: "POST", json: { title } });
      await load();
      go({ sandbox: d.sandbox.id, a: current?.key ?? null });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const saveArtifact = async (a: { key?: string; kind: string; title: string; body: string; data: unknown }) => {
    try {
      await api(`${apiBase}/sandboxes/${sandboxId}/artifacts`, { method: "POST", json: a });
      await loadSandbox();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  if (error && !detail) return <div className="p-8 text-sm text-danger" role="alert">{error}</div>;
  if (!detail) return <div className="p-8 text-sm text-muted">Loading…</div>;
  const c = detail.creation;
  const isOwner = detail.role === "owner";
  // You edit only your own sandboxes (the owner may also work system-made ones). Others' are read-only.
  const canEdit = mode === "sandbox" && !!sandbox &&
    (sandbox.sandbox.owner === detail.viewer || (isOwner && (sandbox.sandbox.owner_kind === "agent" || sandbox.sandbox.owner === "system")));
  const phaseIdx = PHASES.findIndex((p) => p.key === c.phase);
  const setPhase = (key: string) => isOwner && key !== c.phase && run(() => api(`${apiBase}/${slug}`, { method: "PATCH", json: { phase: key } }));
  const needsYou = detail.promotions.filter((p) => p.status === "pending").length + detail.feed.filter((f) => f.kind === "comment" && !f.resolved_at).length;
  const tab = (active: boolean) =>
    `shrink-0 px-3 py-1.5 text-sm rounded-full border whitespace-nowrap transition-colors ${active ? "border-gold bg-gold-soft text-foreground" : "border-panel-border text-foreground/80 hover:bg-wash-1"}`;

  return (
    <div className="min-h-full @container" data-testid="creation-workspace">
      <div className="flex flex-col @4xl:h-full min-h-full">
        <header className="px-4 md:px-6 pt-4 pb-3 border-b border-panel-border flex flex-col gap-3">
          <Link href={linkBase} className="text-xs text-muted hover-pill self-start">← All creations</Link>
          <div className="flex items-start gap-3 min-w-0">
            <div className="text-2xl md:text-3xl leading-none shrink-0">{c.icon}</div>
            <div className="min-w-0">
              <h1 className="font-display text-xl md:text-3xl tracking-wide leading-tight">{c.title}</h1>
              {c.tagline && <p className="hidden sm:block text-sm text-muted mt-1 line-clamp-2">{c.tagline}</p>}
            </div>
          </div>
          {/* Phase: dropdown on small screens, steps on wider ones */}
          <label className="md:hidden flex items-center gap-2 text-sm">
            <span className="text-muted shrink-0">Phase {phaseIdx + 1}/{PHASES.length}</span>
            <select value={c.phase} disabled={!isOwner} onChange={(e) => setPhase(e.target.value)} className="flex-1 min-w-0 bg-transparent border border-panel-border rounded-lg px-2 py-1.5">
              {PHASES.map((p, i) => <option key={p.key} value={p.key}>{i + 1}. {p.label}</option>)}
            </select>
          </label>
          <ol className="hidden md:flex gap-1 overflow-x-auto text-xs" data-testid="phase-strip" aria-label="Phase">
            {PHASES.map((p, i) => (
              <li key={p.key} className="shrink-0">
                <button title={`Mirrors: ${p.pattern}`} aria-current={p.key === c.phase ? "step" : undefined} disabled={!isOwner} onClick={() => setPhase(p.key)}
                  className={`px-2.5 py-1 rounded-full border whitespace-nowrap ${p.key === c.phase ? "border-gold bg-gold-soft text-foreground" : i < phaseIdx ? "border-panel-border text-foreground/80" : "border-panel-border text-muted"}`}>
                  {i + 1}. {p.label}
                </button>
              </li>
            ))}
          </ol>
          <div role="tablist" aria-label="What you're looking at" className="flex gap-1.5 overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0 pb-0.5" data-testid="view-tabs">
            <button role="tab" aria-selected={mode === "canon"} data-testid="view-canon" onClick={() => go({ a: current?.key ?? null })} className={tab(mode === "canon")}>
              🔒 Canon v{detail.canon.version.number}
            </button>
            <button role="tab" aria-selected={mode === "execution"} data-testid="view-execution" onClick={() => go({ view: "execution" })} className={tab(mode === "execution")}>
              ▶ Execution
            </button>
            {detail.sandboxes.map((s) => (
              <button key={s.id} role="tab" aria-selected={sandboxId === s.id} data-testid={`view-sandbox-${s.id}`} onClick={() => go({ sandbox: s.id, a: current?.key ?? null })} className={tab(sandboxId === s.id)}>
                {s.owner_kind === "agent" ? "🤖" : "🧪"} {s.title.length > 32 ? s.title.slice(0, 31) + "…" : s.title}{s.change_count ? ` · ${s.change_count}` : ""}
              </button>
            ))}
            {detail.role !== "viewer" && (
              <button onClick={newSandbox} data-testid="new-sandbox" className="shrink-0 px-3 py-1.5 text-sm rounded-full border border-dashed border-panel-border text-muted whitespace-nowrap hover:bg-wash-1">+ New sandbox</button>
            )}
          </div>
        </header>

        {(error || notice) && (
          <div className={`mx-4 md:mx-6 mt-3 rounded-lg px-3 py-2 text-sm ${error ? "bg-wash-2 text-danger" : "bg-wash-1 text-success"}`} role={error ? "alert" : "status"}>{error || notice}</div>
        )}

        {mode === "canon" && (
          <p className="px-4 md:px-6 py-2 text-xs text-muted border-b border-panel-border">
            🔒 <span className="sm:hidden">Official version (canon), read-only. Change it in a sandbox.</span>
            <span className="hidden sm:inline">This is the official version (canon): read-only. To change anything, start a sandbox and propose it back.</span>
          </p>
        )}
        {mode === "version" && oldVersion && (
          <div className="px-4 md:px-6 py-2 text-xs text-muted border-b border-panel-border flex flex-wrap gap-x-3 gap-y-1 items-center">
            <span>Looking back at canon v{oldVersion.version.number} ({oldVersion.version.note}). Read-only.</span>
            <button className="hover-pill underline" onClick={() => go({})}>Back to current</button>
          </div>
        )}
        {mode === "sandbox" && sandbox && !canEdit && (
          <p className="px-4 md:px-6 py-2 text-xs text-muted border-b border-panel-border" data-testid="sandbox-readonly">
            This is {sandbox.sandbox.owner === "system" ? "a starter" : `${sandbox.sandbox.owner.replace(/^agent:/, "the ")}'s`} sandbox: you can look but not change it. Start your own to try ideas.
          </p>
        )}
        {mode === "sandbox" && sandbox && canEdit && (
          <div className="px-4 md:px-6 py-3 border-b border-panel-border flex flex-col gap-2" data-testid="sandbox-bar">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted flex-1 min-w-48">🧪 Your sandbox, started from canon v{sandbox.sandbox.base_version}. Change anything here; canon stays as it is until you propose.</span>
              {sandbox.sandbox.stale && (
                <button className="text-xs px-3 py-1.5 rounded-lg border border-panel-border text-info" data-testid="sandbox-rebase" onClick={() => run(() => api(`${apiBase}/sandboxes/${sandboxId}`, { method: "PATCH", json: { action: "rebase" } }), "Pulled in the latest canon.")}>
                  Get latest canon
                </button>
              )}
              <button disabled={!sandbox.changes.length} onClick={() => setShowPropose((v) => !v)} data-testid="propose-open"
                className="text-sm px-3 py-1.5 rounded-lg bg-accent text-background disabled:opacity-40">
                Propose {sandbox.changes.length || ""} change{sandbox.changes.length === 1 ? "" : "s"}
              </button>
              <button className="text-sm px-3 py-1.5 rounded-lg border border-panel-border text-muted" data-testid="sandbox-archive" onClick={() => {
                if (window.confirm("Archive this sandbox? It's kept, just hidden.")) run(async () => { await api(`${apiBase}/sandboxes/${sandboxId}`, { method: "PATCH", json: { action: "archive" } }); go({}); });
              }}>Archive</button>
            </div>
            {showPropose && (
              <div className="rounded-xl border border-panel-border bg-panel p-3 flex flex-col gap-2" data-testid="propose-panel">
                <p className="text-sm font-medium">What changes if this is approved</p>
                <ChangeList changes={sandbox.changes} />
                <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} maxLength={4000} placeholder="Why should canon change? (optional)"
                  className="w-full min-h-20 text-sm bg-transparent border border-panel-border rounded-lg p-2" data-testid="propose-rationale" />
                <div>
                  <button data-testid="propose-submit" className="px-4 py-2 text-sm rounded-lg bg-accent text-background" onClick={() => run(async () => {
                    await api(`${apiBase}/sandboxes/${sandboxId}/promote`, { method: "POST", json: { rationale } });
                    setShowPropose(false);
                    setRationale("");
                  }, isOwner ? "Proposed. Approve it in the feed when you're ready." : "Sent to Owner for approval.")}>Send for approval</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Small screens: switch between the work and the feed instead of squeezing columns */}
        <div className="@4xl:hidden px-4 pt-3" role="tablist" aria-label="Work or feed">
          <div className="grid grid-cols-2 rounded-xl border border-panel-border p-1 text-sm">
            <button role="tab" aria-selected={pane === "work"} onClick={() => setPane("work")} data-testid="pane-work"
              className={`rounded-lg py-1.5 ${pane === "work" ? "bg-wash-2 font-medium" : "text-muted"}`}>Work</button>
            <button role="tab" aria-selected={pane === "feed"} onClick={() => setPane("feed")} data-testid="pane-feed"
              className={`rounded-lg py-1.5 ${pane === "feed" ? "bg-wash-2 font-medium" : "text-muted"}`}>
              Feed{needsYou > 0 && <span className="ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full bg-accent text-background text-[11px]">{needsYou}</span>}
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex flex-col @4xl:flex-row">
          <section className={`${pane === "feed" ? "hidden @4xl:flex" : "flex"} flex-1 min-w-0 flex-col @7xl:flex-row @4xl:min-h-0`}>
            {mode === "execution" ? (
              <main className="flex-1 min-w-0 p-4 md:p-6 @4xl:overflow-y-auto" data-testid="artifact-pane">
                <ExecutionBoard slug={slug} apiBase={apiBase} isOwner={isOwner} canPropose={detail.role !== "viewer"} />
              </main>
            ) : (
              <>
                <nav className="shrink-0 border-b @7xl:border-b-0 @7xl:border-r border-panel-border px-4 py-2 @7xl:p-3 @7xl:w-64 @7xl:overflow-y-auto" data-testid="artifact-list" aria-label="Artifacts">
                  <ul className="flex @7xl:flex-col gap-1.5 @7xl:gap-1 overflow-x-auto -mx-4 px-4 @7xl:mx-0 @7xl:px-0 pb-1 @7xl:pb-0">
                    {artifacts?.map((a) => (
                      <li key={a.key} className="shrink-0 @7xl:shrink">
                        <button onClick={() => { setSelected(a.key); go({ sandbox: sandboxId, version: versionId, a: a.key }); }} aria-current={current?.key === a.key ? "page" : undefined}
                          className={`w-full text-left text-sm px-3 py-1.5 @7xl:px-2 rounded-full @7xl:rounded-lg border @7xl:border-0 whitespace-nowrap @7xl:whitespace-normal ${current?.key === a.key ? "border-gold bg-gold-soft text-foreground font-medium @7xl:bg-wash-2 @7xl:text-accent" : "border-panel-border hover:bg-wash-1"}`}>
                          {a.title.length > 40 && current?.key !== a.key ? a.title.slice(0, 39) + "…" : a.title}
                          {changedKeys.has(a.key) && <span className="text-info" title="Changed in this sandbox"> •</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {canEdit && (
                    <form className="mt-2 @7xl:mt-3 flex gap-1" onSubmit={(e) => {
                      e.preventDefault();
                      if (!newArt.trim()) return;
                      run(async () => {
                        const d = await api<{ artifact: Artifact }>(`${apiBase}/sandboxes/${sandboxId}/artifacts`, { method: "POST", json: { kind: "doc", title: newArt, body: "" } });
                        setNewArt("");
                        setSelected(d.artifact.key);
                      });
                    }}>
                      <input value={newArt} onChange={(e) => setNewArt(e.target.value)} placeholder="+ New doc (type a title, press Enter)" maxLength={200} data-testid="new-artifact-title"
                        className="flex-1 min-w-0 text-sm bg-transparent border border-panel-border rounded-lg px-2 py-1.5" />
                    </form>
                  )}
                </nav>
                <main className="flex-1 min-w-0 p-4 md:p-6 @4xl:overflow-y-auto" data-testid="artifact-pane">
                  <div className="max-w-4xl mx-auto">
                    {current ? (
                      <ArtifactView key={`${mode}-${sandboxId ?? versionId ?? 0}-${current.key}${current.kind === "model" || current.kind === "sites" ? "" : `-${sandbox?.sandbox.updated_at ?? detail.creation.updated_at}`}`} artifact={current} editable={canEdit} apiBase={apiBase}
                        sourceRef={mode === "sandbox" ? `s${sandboxId}` : mode === "version" ? `v${versionId}` : `v${detail.canon.version.id}`} onSave={canEdit ? saveArtifact : undefined} />
                    ) : (
                      <p className="text-sm text-muted">No artifacts yet.</p>
                    )}
                  </div>
                </main>
              </>
            )}
          </section>
          <aside className={`${pane === "work" ? "hidden @4xl:flex" : "flex"} flex-col gap-4 @4xl:w-[22rem] shrink-0 @4xl:border-l border-panel-border p-4 @4xl:overflow-y-auto`} aria-label="Feed">
            {isOwner && apiBase === "/api/creations" && <MissionsPanel slug={slug} apiBase={apiBase} onOpenSandbox={(id) => { load(); setPane("work"); go({ sandbox: id }); }} />}
            {isOwner && <MembersPanel slug={slug} apiBase={apiBase} />}
            <FeedPanel detail={detail} onViewVersion={(id) => { setPane("work"); go({ version: id }); }}
              onComment={(body) => run(() => api(`${apiBase}/${slug}/comments`, { method: "POST", json: { body, artifact: current?.title } }))}
              onResolve={(id) => run(() => api(`${apiBase}/feed/${id}`, { method: "POST", json: { action: "resolve" } }))}
              onDecide={(id, d) => run(() => api(`${apiBase}/promotions/${id}`, { method: "POST", json: { decision: d } }), d === "approve" ? "Approved. Canon has a new version." : "Declined.")} />
          </aside>
        </div>
      </div>
    </div>
  );
}
