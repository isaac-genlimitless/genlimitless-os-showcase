"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import CreationsHome from "@/components/creation/CreationsHome";
import { setOsContext } from "@/lib/os-context";
import { defaultIcon, type PageView, type TreeNode } from "@/app/files/types";

const PageEditor = dynamic(() => import("@/components/PageEditor"), {
  ssr: false,
  loading: () => <div className="text-sm text-muted py-4">Loading editor…</div>,
});

const FOLDER_TITLE = "The Creation";
const FALLBACK_IDS = [350, 351, 352, 353]; // used only if the folder can't be found by name

export default function TheCreationPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted">Loading…</div>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const router = useRouter();
  const params = useSearchParams();
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [view, setView] = useState<PageView | null>(null);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    fetch("/api/files").then((r) => r.json()).then((d) => setTree(d.tree || [])).catch(() => setError("Couldn't load Files."));
  }, []);

  const tabs = useMemo(() => {
    if (!tree) return [];
    const folder = tree.find((n) => n.kind === "folder" && n.title.trim() === FOLDER_TITLE);
    const kids = folder
      ? tree.filter((n) => n.parent_id === folder.id && n.kind === "page").sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
      : FALLBACK_IDS.map((id) => tree.find((n) => n.id === id)).filter((n): n is TreeNode => !!n);
    return kids;
  }, [tree]);

  const tabParam = Number(params.get("tab"));
  // No tab = the Creations home (the invention studio). Files pages keep their tabs.
  const isStudio = !params.get("tab") || params.get("tab") === "studio";
  const activeId = isStudio ? null : (tabs.find((t) => t.id === tabParam)?.id ?? tabs[0]?.id ?? null);

  useEffect(() => {
    setView(null);
    setSaveState("idle");
    if (!activeId) return;
    let live = true;
    fetch(`/api/files/${activeId}`).then(async (r) => {
      if (!live) return;
      if (!r.ok) return setError("That page couldn't be loaded.");
      setError("");
      const v = await r.json();
      if (live) setView(v);
    }).catch(() => { if (live) setError("That page couldn't be loaded."); });
    return () => { live = false; };
  }, [activeId]);

  useEffect(() => {
    setOsContext(isStudio ? "The Creation: home (all creations, /api/creations)" : view ? `The Creation: page "${view.page.title}" (page_id ${view.page.id}, /files?id=${view.page.id})` : "The Creation");
    return () => setOsContext(null);
  }, [view, isStudio]);

  const pick = useCallback((id: number) => router.push(`/the-creation?tab=${id}`), [router]);
  const onSaving = useCallback(() => setSaveState("saving"), []);
  const onSaved = useCallback(() => setSaveState("saved"), []);

  return (
    <div className="h-full flex flex-col" data-testid="the-creation-page">
      <div className="px-4 md:px-12 pt-8 border-b border-panel-border">
        <h1 className="font-display text-3xl tracking-wide mb-4">The Creation</h1>
        <div role="tablist" className="flex gap-1 overflow-x-auto" data-testid="creation-tabs">
          <button role="tab" aria-selected={isStudio} data-testid="creation-tab-studio" onClick={() => router.push("/the-creation")}
            className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 ${isStudio ? "border-gold text-accent" : "border-transparent text-foreground/80 hover:bg-wash-2 rounded-t-lg"}`}>
            ✨ Creations
          </button>
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === activeId} data-testid={`creation-tab-${t.id}`} onClick={() => pick(t.id)}
              className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 ${t.id === activeId ? "border-gold text-accent" : "border-transparent text-foreground/80 hover:bg-wash-2 rounded-t-lg"}`}>
              {t.icon || defaultIcon(t.kind, t.mime_type)} {t.title}
            </button>
          ))}
        </div>
      </div>
      {isStudio ? (
        <CreationsHome />
      ) : (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-4 md:px-12 pt-6 pb-32">
          {error && <div role="alert" className="text-sm text-danger mb-4">{error}</div>}
          {tree && !tabs.length &&<div className="text-sm text-muted">No pages found in the Files folder “{FOLDER_TITLE}”.</div>}
          {view && (
            <>
              <div className="flex items-center justify-between text-xs text-muted mb-4">
                <Link href={`/files?id=${view.page.id}`} className="hover-pill">Open in Files →</Link>
                {saveState !== "idle" && <span data-testid="save-state">{saveState === "saving" ? "Saving…" : "Saved"}</span>}
              </div>
              <h2 className="text-3xl font-bold mb-4">{view.page.title}</h2>
              <PageEditor key={view.page.id} pageId={view.page.id} initialBlocks={view.blocks}
                onSaving={onSaving} onSaved={onSaved} />
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
