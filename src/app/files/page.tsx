"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { setOsContext } from "@/lib/os-context";
import { setFocusMode, useFocusMode } from "@/lib/focus-mode";
import FileComments from "@/components/FileComments";
import { FilesTree,type TreeActions } from "./FilesTree";
import { FIcon } from "./FilesIcons";
import { defaultIcon, fmtDate, fmtSize, type Child, type Hit, type PageView, type TreeNode } from "./types";

const PageEditor = dynamic(() => import("@/components/PageEditor"), {
  ssr: false,
  loading: () => <div className="text-sm text-muted py-4">Loading editor…</div>,
});

// Files: Owner's Notion-style workspace. Folders and nested pages in a tree, rich pages edited
// in place, uploaded files with previews, meeting notes, full-text search, and a Trash. New
// items with no folder get filed automatically by the AI (and say so).

const EMOJIS = "📄 📁 🗂️ 📝 📌 ⭐ 🎯 🚀 💡 🧠 📈 📊 💰 🤝 🏫 🎓 👥 📣 ✉️ 📅 🎙️ 🛠️ ⚙️ 🧪 🔒 ✅ 🔥 🌱 🏁 📚 🗺️ 🧭 ❤️ 🙂 🏠 ✈️".split(" ");

const FOCUS_KEY = "os.files.focus";
const SIDEBAR_KEY = "os.files.sidebar";

function readExpanded(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem("os.files.expanded") || "[]"));
  } catch {
    return new Set();
  }
}

export default function FilesPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted">Loading…</div>}>
      <FilesInner />
    </Suspense>
  );
}

function FilesInner() {
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = params.get("id") ? Number(params.get("id")) : null;
  const showTrash = params.get("view") === "trash";

  const [tree, setTree] = useState<TreeNode[]>([]);
  const [recent, setRecent] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [view, setView] = useState<PageView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [menu, setMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null);
  const [moving, setMoving] = useState<TreeNode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadParent = useRef<number | null>(null);

  const focus = useFocusMode();
  const toggleFocus = useCallback((on: boolean) => {
    setFocusMode(on);
    try {
      sessionStorage.setItem(FOCUS_KEY, on ? "1" : "0");
    } catch {
      /* not remembered */
    }
  }, []);
  useEffect(() => {
    try {
      if (sessionStorage.getItem(FOCUS_KEY) === "1") setFocusMode(true);
    } catch {
      /* not remembered */
    }
    return () => setFocusMode(false);
  }, []);
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || menu || moving) return;
      if ((e.target as HTMLElement | null)?.closest?.("[data-testid=chat-dock]")) return;
      toggleFocus(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, menu, moving, toggleFocus]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [drawer, setDrawer] = useState(false); // mobile-only tree drawer
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    try { if (localStorage.getItem(SIDEBAR_KEY) === "0") setSidebarOpen(false); } catch { /* not remembered */ }
  }, []);
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((o) => {
      try { localStorage.setItem(SIDEBAR_KEY, o ? "0" : "1"); } catch { /* not remembered */ }
      return !o;
    });
  }, []);
  const itemShown =!hits && !showTrash && !!selectedId && !notFound && !!view;

  const loadTree = useCallback(async () => {
    const d = await fetch("/api/files").then((r) => r.json());
    setTree(d.tree || []);
    setRecent(d.recent || []);
  }, []);

  const loadView = useCallback(async (id: number) => {
    const res = await fetch(`/api/files/${id}`);
    if (!res.ok) {
      setView(null);
      setNotFound(true);
      return;
    }
    setNotFound(false);
    setView(await res.json());
  }, []);

  useEffect(() => {
    setExpanded(readExpanded());
    loadTree();
  }, [loadTree]);

  useEffect(() => {
    try {
      localStorage.setItem("os.files.expanded", JSON.stringify([...expanded]));
    } catch {
      /* not remembered */
    }
  }, [expanded]);

  useEffect(() => {
    setView(null);
    setNotFound(false);
    if (selectedId) loadView(selectedId);
  }, [selectedId, loadView]);

  // Expand the path to whatever is open, so it's visible in the tree.
  useEffect(() => {
    if (!view) return;
    setExpanded((cur) => {
      const next = new Set(cur);
      view.breadcrumb.forEach((b) => next.add(b.id));
      return next.size === cur.size ? cur : next;
    });
  }, [view]);

  // Tell the docked Chief of Staff what's open.
  useEffect(() => {
    if (view) {
      const where = view.breadcrumb.map((b) => b.title).join(" / ");
      setOsContext(`Files: ${view.page.kind} "${view.page.title}" (page_id ${view.page.id}${where ? `, in ${where}` : ""}, /files?id=${view.page.id})`);
    } else setOsContext("the Files workspace (no page open)");
    return () => setOsContext(null);
  }, [view]);

  // A page filed by the AI moves a few seconds after it's created; keep the tree fresh.
  useEffect(() => {
    const t = setInterval(() => !document.hidden && loadTree(), 20_000);
    return () => clearInterval(t);
  }, [loadTree]);

  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    const t = setTimeout(async () => {
      const d = await fetch(`/api/files?q=${encodeURIComponent(query)}`).then((r) => r.json());
      setHits(d.hits || []);
    }, 180);
    return () => clearTimeout(t);
  }, [query]);

  const open = useCallback((id: number) => router.push(`/files?id=${id}`), [router]);

  const toggle = useCallback((id: number, force?: boolean) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      const want = force ?? !next.has(id);
      if (want) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  async function patch(id: number, body: object) {
    const res = await fetch(`/api/files/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json();
    if (!res.ok) alert(d.error || "Couldn't save that.");
    return res.ok;
  }

  async function newInside(parentId: number | null, kind: "page" | "folder") {
    const res = await fetch("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, parent_id: parentId, title: kind === "folder" ? "New folder" : "Untitled" }),
    });
    const d = await res.json();
    if (!res.ok) return alert(d.error);
    if (parentId) toggle(parentId, true);
    await loadTree();
    open(d.page.id);
  }

  async function move(id: number, parentId: number | null) {
    if (await patch(id, { parent_id: parentId })) {
      await loadTree();
      if (selectedId) loadView(selectedId);
    }
  }

  async function uploadInto(parentId: number | null, files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setBusy(`Uploading ${list.length} file${list.length === 1 ? "" : "s"}…`);
    try {
      const form = new FormData();
      if (parentId) form.set("parent_id", String(parentId));
      list.forEach((f) => form.append("files", f));
      const res = await fetch("/api/files", { method: "POST", body: form });
      const d = await res.json();
      if (!res.ok) return alert(d.error);
      await loadTree();
      if (d.pages?.length === 1) open(d.pages[0].id);
      else if (selectedId) loadView(selectedId);
    } finally {
      setBusy(null);
    }
  }

  async function trash(node: { id: number; title: string }) {
    if (!confirm(`Move "${node.title}" (and anything inside it) to the Trash? You can restore it from there.`)) return;
    await fetch(`/api/files/${node.id}`, { method: "DELETE" });
    await loadTree();
    if (selectedId === node.id || view?.breadcrumb.some((b) => b.id === node.id)) router.push("/files");
  }

  async function autoFile(id: number) {
    setBusy("Filing with AI…");
    try {
      const d = await fetch("/api/files/organize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).then((r) => r.json());
      if (d.error) alert(d.error);
      await loadTree();
      if (selectedId) loadView(selectedId);
    } finally {
      setBusy(null);
    }
  }

  async function tidyUp() {
    if (!confirm("Let the AI file every unfiled item at the top level into folders (and tag and summarize them)? Items you placed yourself are never moved.")) return;
    setBusy("Organizing your workspace…");
    try {
      const d = await fetch("/api/files/organize", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json());
      if (d.error) alert(d.error);
      await loadTree();
    } finally {
      setBusy(null);
    }
  }

  const actions: TreeActions = {
    open,
    newInside,
    move,
    uploadInto,
    menu: (node, r) => setMenu({ node, x: r.left, y: r.bottom + 4 }),
  };

  const unfiled = useMemo(() => tree.filter((n) => n.parent_id == null && n.kind !== "folder" && !n.placed_by), [tree]);

  return (
    <div
      className="h-full flex flex-col md:flex-row"
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        const here = view && view.page.kind !== "file" ? view.page.id : view?.page.parent_id ?? null;
        uploadInto(here, e.dataTransfer.files);
      }}
    >
      {/* ------------------------------------------------ sidebar */}
      {drawer && !focus && <div data-testid="files-drawer-backdrop" aria-hidden onClick={() => setDrawer(false)} className="md:hidden fixed inset-0 z-30 bg-black/50" />}
      <div
        data-testid="files-panel"
        onClick={(e) => { if ((e.target as HTMLElement).closest("a,button")) setDrawer(false); }}
        className={
          focus
            ? "hidden"
            : `${drawer ? "flex fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] bg-panel shadow-xl" : "hidden"} ${sidebarOpen ? "md:static md:flex md:z-auto md:shadow-none md:bg-panel/40" : "md:hidden"} md:w-72 shrink-0 md:max-h-none md:border-r border-panel-border flex-col`
        }
      >
        <div className="px-4 pt-6 pb-3 space-y-3 border-b border-panel-border">
          <div className="flex items-center justify-between">
            <Link href="/files" className="font-display text-2xl tracking-wide hover:text-accent">
              Files
            </Link>
            <div className="flex gap-1">
              <button type="button" data-testid="files-drawer-close" aria-label="Close file tree" title="Close file tree" onClick={() => setDrawer(false)} className="md:hidden hover-pill">
                <FIcon name="close" />
              </button>
              <button data-testid="files-add-page" aria-label="Add page" title="Add page" onClick={() => newInside(null, "page")} className="hover-pill">
                <FIcon name="plus-page" />
              </button>
              <button
                onClick={() => {
                  uploadParent.current = view && view.page.kind !== "file" ? view.page.id : null;
                  uploadRef.current?.click();
                }}
                className="hover-pill"
                aria-label="Upload files"
                title="Upload files"
              >
                <FIcon name="upload" />
              </button>
            </div>
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search everything…"
            className="w-full bg-panel border border-panel-border rounded-lg px-3 py-2 text-sm outline-none focus:border-gold"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <FilesTree nodes={tree} selectedId={selectedId} expanded={expanded} toggle={toggle} actions={actions} />
        </div>
        <div className="border-t border-panel-border p-2 flex items-center justify-between text-xs">
          <Link href="/files?view=trash" aria-label="Trash" title="Trash" className={`hover-pill ${showTrash ? "text-accent" : "text-muted"}`}>
            <FIcon name="trash" />
          </Link>
          <button onClick={tidyUp} className="hover-pill text-muted" aria-label="Auto-organize" title="AI files everything unfiled into folders">
            <FIcon name="sparkle" />
          </button>
        </div>
        <input
          ref={uploadRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = "";
            uploadInto(uploadParent.current, picked);
          }}
        />
      </div>

      {/* ------------------------------------------------ main */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <div data-testid="files-topbar" className="shrink-0 z-20 flex items-center gap-3 px-4 md:px-6 py-2 border-b border-panel-border bg-background text-xs text-muted">
          <span className="hidden md:contents">
          <button type="button" data-testid="files-sidebar-toggle" onClick={toggleSidebar}
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"} aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"} aria-pressed={sidebarOpen}
            className="hover-pill shrink-0 hover:text-accent">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" />
            </svg>
          </button>
          </span>
          <div ref={setBarSlot} className="flex-1 min-w-0 flex items-center justify-between gap-4" />
        </div>
        <div data-testid="files-scroller" className="flex-1 min-h-0 overflow-y-auto">
        {busy && <div className="sticky top-0 z-20 bg-gold text-black text-xs font-medium px-4 py-1.5">{busy}</div>}
        {hits ? (
          <SearchResults hits={hits} query={query} onOpen={(id) => { setQuery(""); open(id); }} />
        ) : showTrash ? (
          <TrashView onChanged={loadTree} />
        ) : selectedId && notFound ? (
          <div className="p-10 text-sm text-muted">That page doesn&apos;t exist anymore. It may be in the Trash.</div>
        ) : selectedId && view ? (
          <ItemView
            key={view.page.id}
            view={view}
            tree={tree}
            onOpen={open}
            onPatch={async (body) => {
              const ok = await patch(view.page.id, body);
              if (ok) {
                await loadTree();
                await loadView(view.page.id);
              }
            }}
            onTreeChanged={loadTree}
            onNewInside={newInside}
            onUpload={() => {
              uploadParent.current = view.page.kind !== "file" ? view.page.id : view.page.parent_id;
              uploadRef.current?.click();
            }}
            onTrash={() => trash(view.page)}
            onAutoFile={() => autoFile(view.page.id)}
            onMove={() => setMoving(view.page)}
            focus={focus}
            onToggleFocus={toggleFocus}
            slot={barSlot}
            wide={focus || !sidebarOpen}
          />
        ) : selectedId ? (
          <div className="p-10 text-sm text-muted">Loading…</div>
        ) : (
          <Home tree={tree} recent={recent} unfiled={unfiled} onOpen={open} onTidy={tidyUp} onNew={() => newInside(null, "page")} />
        )}
        </div>
      </div>

      <button
        type="button"
        data-testid="files-mobile-menu"
        aria-label="Open file tree"
        title="Open file tree"
        onClick={() => setDrawer(true)}
        className="md:hidden fixed bottom-4 left-4 z-30 w-11 h-11 rounded-full bg-gold text-black shadow-lg flex items-center justify-center"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      {focus && !itemShown && (
        <div className="fixed top-3 right-3 z-30">
          <FocusToggle on onToggle={toggleFocus} />
        </div>
      )}
      {menu && (
        <ItemMenu
          node={menu.node}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onNew={(kind) => newInside(menu.node.id, kind)}
          onFavorite={async () => {
            await patch(menu.node.id, { favorite: !menu.node.favorite });
            loadTree();
          }}
          onRename={async () => {
            const t = prompt("Rename", menu.node.title);
            if (t && t.trim()) {
              await patch(menu.node.id, { title: t.trim() });
              await loadTree();
              if (selectedId === menu.node.id) loadView(menu.node.id);
            }
          }}
          onMove={() => setMoving(menu.node)}
          onAutoFile={() => autoFile(menu.node.id)}
          onTrash={() => trash(menu.node)}
        />
      )}
      {moving && (
        <MoveDialog
          node={moving}
          tree={tree}
          onClose={() => setMoving(null)}
          onPick={async (parentId) => {
            setMoving(null);
            await move(moving.id, parentId);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- item view

function ItemView({
  view,
  tree,
  onOpen,
  onPatch,
  onTreeChanged,
  onNewInside,
  onUpload,
  onTrash,
  onAutoFile,
  onMove,
  focus,
  onToggleFocus,
  slot,
  wide,
}: {
  slot: HTMLElement | null;
  wide: boolean;
  focus: boolean;
  onToggleFocus: (on: boolean) => void;
  view: PageView;
  tree: TreeNode[];
  onOpen: (id: number) => void;
  onPatch: (body: object) => Promise<void>;
  onTreeChanged: () => void;
  onNewInside: (parentId: number | null, kind: "page" | "folder") => void;
  onUpload: () => void;
  onTrash: () => void;
  onAutoFile: () => void;
  onMove: () => void;
}) {
  const p = view.page;
  const [title, setTitle] = useState(p.title);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [iconOpen, setIconOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [linkEditing, setLinkEditing] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const linkLabel = /^resume/i.test(p.title) ? "JD link" : "Link";
  const parent =tree.find((n) => n.id === p.parent_id);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);
  // A brand-new page: start typing its title straight away.
  useEffect(() => {
    if (p.title === "Untitled" && p.kind === "page") titleRef.current?.select();
  }, [p.title, p.kind]);

  async function saveTitle() {
    const t = title.trim() || "Untitled";
    if (t !== p.title) await onPatch({ title: t });
  }

  return (
    <div className={`${wide ? "max-w-none md:px-16" : "max-w-4xl md:px-12"} mx-auto px-4 pt-8 pb-32`}>
      {p.status === "archived" && (
        <div className="mb-6 border border-danger/50 bg-danger/10 rounded-lg px-4 py-2 text-sm flex items-center justify-between">
          <span>This is in the Trash.</span>
          <button onClick={() => onPatch({ restore: true })} className="text-xs border border-panel-border rounded px-3 py-1 hover:border-gold">Restore</button>
        </div>
      )}
      {/* breadcrumb + actions */}
      {slot && createPortal(<>
        <div data-testid="files-breadcrumb" className="flex items-center gap-1 min-w-0 flex-1 md:flex-none md:flex-wrap">
          <Link href="/files" className="hover-pill">Files</Link>
          {view.breadcrumb.map((b, i) => (
            <span key={b.id} className={`${i < view.breadcrumb.length - 1 ? "hidden md:flex" : "flex"} items-center gap-1 min-w-0`}>
              <span>/</span>
              <button onClick={() => onOpen(b.id)} className="hover-pill truncate max-w-40">
                {b.icon ? `${b.icon} ` : ""}
                {b.title}
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 md:gap-3 shrink-0">
          {saveState !== "idle" && <span data-testid="save-state">{saveState === "saving" ? "Saving…" : "Saved"}</span>}
          <span className="hidden md:contents"><FocusToggle on={focus} onToggle={onToggleFocus} /></span>
          <span className="hidden md:contents">
            <button onClick={() => onPatch({ favorite: !p.favorite })} className="hover-pill" aria-label={p.favorite ? "Remove from favorites" : "Add to favorites"} title={p.favorite ? "Remove from favorites" : "Add to favorites"}>
              <FIcon name={p.favorite ? "star-fill" : "star"} />
            </button>
            {p.kind === "page" && <ShareMenu key={p.id} id={p.id} initialToken={p.share_token ?? null} />}
            {(p.kind === "page" || p.kind === "meeting") && <DownloadMenu id={p.id} disabled={saveState === "saving"} />}
          </span>
          <span data-testid="file-comments-slot" className="contents" />
          <span className="hidden md:contents">
            <button onClick={onMove} className="hover-pill" aria-label="Move" title="Move">
              <FIcon name="move" />
            </button>
            <button onClick={onTrash} className="hover-pill" aria-label="Trash" title="Trash">
              <FIcon name="trash" />
            </button>
          </span>
          <MobileActionsMenu p={p} saving={saveState === "saving"} onFavorite={() => onPatch({ favorite: !p.favorite })} onMove={onMove} onTrash={onTrash} />
        </div>
      </>, slot)}

      {/* icon + title */}
      <div className="relative mb-2 group">
        <button onClick={() => setIconOpen((o) => !o)} className="text-5xl leading-none hover:bg-wash-2 rounded p-1 -ml-1" title="Change icon">
          {p.icon || defaultIcon(p.kind, p.mime_type)}
        </button>
        {p.icon && (
          <button data-testid="remove-icon-inline" title="Remove icon" aria-label="Remove icon" onClick={() => onPatch({ icon: null })} className="ml-2 align-middle text-xs text-muted hover:text-danger opacity-0 group-hover:opacity-100 focus:opacity-100">
            Remove icon
          </button>
        )}
        {iconOpen && (
          <div className="absolute z-30 mt-2 p-2 bg-panel border border-panel-border rounded-lg shadow-xl grid grid-cols-9 gap-1 w-[min(20rem,calc(100vw-2rem))]">
            {EMOJIS.map((e) => (
              <button
                key={e}
                onClick={() => {
                  setIconOpen(false);
                  onPatch({ icon: e });
                }}
                className="text-xl hover:bg-wash-3 rounded p-1"
              >
                {e}
              </button>
            ))}
            {p.icon && (
              <button data-testid="remove-icon" onClick={() => { setIconOpen(false); onPatch({ icon: null }); }} className="col-span-9 text-xs text-danger hover:underline mt-1 text-left">
                Remove icon
              </button>
            )}
          </div>
        )}
      </div>
      <textarea
        ref={titleRef}
        rows={1}
        value={title}
        onChange={(e) => setTitle(e.target.value.replace(/\n/g, ""))}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        aria-label="Title"
        placeholder="Untitled"
        className="w-full resize-none overflow-hidden bg-transparent text-4xl font-bold leading-tight outline-none placeholder:text-muted/40 mb-3"
      />

      {/* properties */}
      <div className="text-xs text-muted space-y-2 mb-6 border-b border-panel-border pb-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>Updated {fmtDate(p.updated_at)}</span>
          {p.created_by === "agent" && <span className="text-accent">Created by Chief</span>}
          {p.placed_by === "ai" && (
            <span>
              ✦ Filed by AI in <b className="text-foreground/80">{parent?.title || "top level"}</b> ·{" "}
              <button onClick={onMove} className="underline hover:text-foreground">move</button>
            </span>
          )}
          {!p.placed_by && p.parent_id == null && p.kind !== "folder" && (
            <button onClick={onAutoFile} className="hover:text-accent">✦ File this with AI</button>
          )}
        </div>
        {p.summary && <div className="text-foreground/70 italic">{p.summary}</div>}
        <div className="flex flex-wrap items-center gap-1.5">
          {p.tags.map((t) => (
            <span key={t} className="group border border-panel-border rounded-full px-2 py-0.5 text-foreground/80">
              #{t}
              <button onClick={() => onPatch({ tags: p.tags.filter((x) => x !== t) })} className="ml-1 opacity-0 group-hover:opacity-100 hover:text-danger" aria-label={`Remove tag ${t}`}>
                ×
              </button>
            </span>
          ))}
          <input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && tagDraft.trim()) {
                onPatch({ tags: [...p.tags, tagDraft.trim().toLowerCase()] });
                setTagDraft("");
              }
            }}
            placeholder="+ tag"
            className="bg-transparent outline-none w-20 placeholder:text-muted/60"
          />
          {p.link && !linkEditing && (
            <span data-testid="page-link-chip" className="group border border-panel-border rounded-full px-2 py-0.5 text-foreground/80">
              <a href={p.link} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline" title={p.link}>
                🔗 {linkLabel}
              </a>
              <button
                data-testid="edit-link"
                aria-label="Edit link"
                onClick={() => {
                  setLinkDraft(p.link!);
                  setLinkEditing(true);
                }}
                className="ml-1 opacity-0 group-hover:opacity-100"
              >
                ✎
              </button>
              <button data-testid="clear-link" aria-label="Clear link" onClick={() => onPatch({ link: null })} className="ml-1 opacity-0 group-hover:opacity-100 hover:text-danger">
                ×
              </button>
            </span>
          )}
          {!p.link && !linkEditing && (
            <button
              data-testid="add-link"
              onClick={() => {
                setLinkDraft("");
                setLinkEditing(true);
              }}
              className="text-muted/60 hover:text-foreground"
            >
              + link
            </button>
          )}
          {linkEditing && (
            <input
              data-testid="page-link-input"
              autoFocus
              aria-label="Link"
              placeholder="https://…"
              value={linkDraft}
              className="bg-transparent outline-none w-56 border-b border-panel-border"
              onChange={(e) => setLinkDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = linkDraft.trim();
                  if (v && !/^https?:\/\/\S+$/i.test(v)) return;
                  setLinkEditing(false);
                  if (v !== (p.link ?? "")) onPatch({ link: v || null });
                } else if (e.key === "Escape") {
                  setLinkEditing(false);
                }
              }}
            />
          )}
        </div>
      </div>

      {view.meeting && <MeetingStrip meeting={view.meeting} />}

      {p.kind === "page" && p.tags.includes("html-diagram") && (
        <div className="mb-4">
          <div className="flex items-center justify-end mb-1 text-xs">
            <a href={`/api/files/${p.id}/html`} target="_blank" rel="noopener" className="text-muted hover:text-foreground underline">
              Open full screen
            </a>
          </div>
          <iframe
            src={`/api/files/${p.id}/html`}
            sandbox=""
            title={p.title}
            className="w-full h-[85vh] rounded border border-panel-border bg-[#0f1419]"
            data-testid="html-diagram-frame"
          />
        </div>
      )}

      {(p.kind === "page" || p.kind === "meeting") && (
        <>
          <PageEditor
            pageId={p.id}
            initialBlocks={view.blocks}
            onSaving={() => setSaveState("saving")}
            onSaved={() => {
              setSaveState("saved");
              onTreeChanged();
            }}
            onSubPageCreated={() => onTreeChanged()}
          />
          <FileComments pageId={p.id} />
          {view.children.length > 0 && (
            <div className="mt-10">
              <div className="text-[11px] uppercase tracking-wider text-muted mb-2">Sub-pages</div>
              <ChildGrid items={view.children} onOpen={onOpen} />
            </div>
          )}
        </>
      )}

      {p.kind === "folder" && (
        <div>
          <div className="flex gap-2 mb-5">
            <button onClick={() => onNewInside(p.id, "page")} className="hover-pill" aria-label="Add page" title="Add page"><FIcon name="plus-page" /></button>
            <button onClick={() => onNewInside(p.id, "folder")} className="hover-pill" aria-label="New folder" title="New folder"><FIcon name="folder-plus" /></button>
            <button onClick={onUpload} className="hover-pill" aria-label="Upload here" title="Upload here"><FIcon name="upload" /></button>
          </div>
          {view.children.length ? <ChildGrid items={view.children} onOpen={onOpen} /> : <div className="text-sm text-muted">This folder is empty. Drop files here to upload them.</div>}
        </div>
      )}

      {p.kind === "file" && <FilePreview view={view} />}
    </div>
  );
}

function FocusToggle({ on, onToggle }: { on: boolean; onToggle: (on: boolean) => void }) {
  const label = on ? "Exit full screen" : "Full screen";
  return (
    <button
      type="button"
      data-testid="files-fullscreen-toggle"
      title={label}
      aria-label={label}
      aria-pressed={on}
      onMouseDown={(e) => e.preventDefault()} /* keep the editor's cursor/selection */
      onClick={() => onToggle(!on)}
      className="hover:bg-wash-2 border border-panel-border rounded-lg p-1.5 bg-panel/60"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={on ? "M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" : "M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"} />
      </svg>
    </button>
  );
}

const MENU_ROW = "flex items-center gap-2 w-full text-left px-3 py-2 text-sm text-foreground hover:bg-wash-2";

function MobileActionsMenu({ p, saving, onFavorite, onMove, onTrash }: {
  p: { id: number; kind: string; favorite?: boolean | number | null; share_token?: string | null };
  saving: boolean; onFavorite: () => void; onMove: () => void; onTrash: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="md:hidden relative">
      <button type="button" data-testid="files-actions-menu" aria-label="More actions" title="More actions" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)} className="hover-pill">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" />
        </svg>
      </button>
      <div className={open ? "" : "hidden"}>
        <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
        <div role="menu" data-testid="files-actions-list" className="absolute right-0 z-30 mt-2 w-60 max-w-[calc(100vw-1.5rem)] bg-panel border border-panel-border rounded-lg shadow-xl py-1">
          <button type="button" role="menuitem" className={MENU_ROW} onClick={() => { onFavorite(); setOpen(false); }}>
            <FIcon name={p.favorite ? "star-fill" : "star"} /> {p.favorite ? "Remove from favorites" : "Add to favorites"}
          </button>
          {p.kind === "page" && <ShareMenu inline key={p.id} id={p.id} initialToken={p.share_token ?? null} />}
          {(p.kind === "page" || p.kind === "meeting") && <DownloadMenu inline id={p.id} disabled={saving} />}
          <button type="button" role="menuitem" className={MENU_ROW} onClick={() => { setOpen(false); onMove(); }}>
            <FIcon name="move" /> Move
          </button>
          <button type="button" role="menuitem" className={`${MENU_ROW} text-danger`} onClick={() => { setOpen(false); onTrash(); }}>
            <FIcon name="trash" /> Move to Trash
          </button>
        </div>
      </div>
    </div>
  );
}

function ShareMenu({ id, initialToken, inline = false }: { id: number; initialToken: string | null; inline?: boolean }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(initialToken);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [revoked, setRevoked] = useState(false);
  const [copied, setCopied] = useState(false);
  const link = token ? `${typeof window !== "undefined" ? window.location.origin : ""}/share/${token}` : "";
  type EditRow = { id: number; editor: string; created_at: string; removed_chars: number; added_chars: number; restored_at: string | null };
  const [editOn, setEditOn] = useState(false);
  const [noExpiry, setNoExpiry] = useState(false);
  const [expiryDate, setExpiryDate] = useState(() => new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
  const [editLink, setEditLink] = useState("");
  const [editCopied, setEditCopied] = useState(false);
  const [edits, setEdits] = useState<EditRow[]>([]);
  const loadEdit = useCallback(async () => {
    try {
      const res = await fetch(`/api/files/${id}/edit-access`);
      if (!res.ok) return;
      const j = await res.json();
      setEditOn(!!j.active);
      setEdits((j.edits || []).slice(0, 10));
      if (j.expires_at) {
        setNoExpiry(false);
        setExpiryDate(String(j.expires_at).slice(0, 10));
      } else if (j.active) setNoExpiry(true);
    } catch {
      /* leave as is */
    }
  }, [id]);
  useEffect(() => {
    if (open && token) loadEdit();
  }, [open, token, loadEdit]);
  const expiryIso = () => (noExpiry || !expiryDate ? null : new Date(`${expiryDate}T23:59:59`).toISOString());
  async function editAction(payload: Record<string, unknown>) {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/files/${id}/edit-access`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error || `Failed (${res.status})`);
        return;
      }
      if (j.path) {
        setEditLink(`${window.location.origin}${j.path}`);
        setEditCopied(false);
      }
      if (payload.action === "disable") setEditLink("");
      await loadEdit();
    } catch (e) {
      setErr(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  async function toggle(enabled: boolean) {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/files/${id}/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error || `Share failed (${res.status})`);
        return;
      }
      setToken(j.token ?? null);
      setRevoked(!enabled);
      setCopied(false);
      if (!enabled) {
        setEditLink("");
        setEditOn(false);
      }
    } catch (e) {
      setErr(`Share failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      /* the input is selectable as a fallback */
    }
  }
  return (
    <div className={inline ? "" : "relative"}>
      {inline ? (
        <button onClick={() => setOpen((o) => !o)} className={`${MENU_ROW} ${token ? "text-accent" : ""}`} data-testid="share-menu-mobile" aria-haspopup="dialog" aria-expanded={open}>
          <FIcon name="share" /> {token ? "Share – manage link" : "Share"}
        </button>
      ) : (
        <button onClick={() => setOpen((o) => !o)} className={`hover-pill ${token ? "text-accent" : ""}`} data-testid="share-menu" aria-label={token ? "Shared - manage link" : "Share"} title={token ? "Shared - manage link" : "Share"} aria-haspopup="dialog" aria-expanded={open}>
          <FIcon name="share" />
        </button>
      )}
      {open && (
        <>
          {!inline && <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />}
          <div className={`${inline ? "mt-1 mx-2 w-auto" : "absolute right-0 z-30 mt-2 w-80"} bg-panel border border-panel-border rounded-lg shadow-xl p-3 text-sm text-foreground space-y-2`}>
            <label className="flex items-center gap-2">
              <input type="checkbox" data-testid="share-toggle" checked={!!token} disabled={busy} onChange={(e) => toggle(e.target.checked)} />
              Anyone with the link can view (read-only)
            </label>
            {token && (
              <div className="flex gap-2">
                <input data-testid="share-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="flex-1 min-w-0 bg-wash-2 border border-panel-border rounded px-2 py-1 text-xs" />
                <button type="button" data-testid="share-copy" onClick={copy} className="text-xs border border-panel-border rounded px-2 hover:border-gold">{copied ? "Copied" : "Copy"}</button>
              </div>
            )}
            {token && (
              <div className="border-t border-panel-border pt-2 space-y-2">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    data-testid="edit-toggle"
                    checked={editOn}
                    disabled={busy}
                    onChange={(e) => (e.target.checked ? editAction({ action: "enable", expires_at: expiryIso() }) : editAction({ action: "disable" }))}
                  />
                  <span>Allow editing (anyone with the edit link can change this page&apos;s text)</span>
                </label>
                {editOn && (
                  <>
                    <div className="flex items-center gap-2 text-xs">
                      <span>Expires</span>
                      <input type="date" data-testid="edit-expiry" value={expiryDate} disabled={noExpiry || busy} onChange={(e) => setExpiryDate(e.target.value)} className="bg-wash-2 border border-panel-border rounded px-1 py-0.5" />
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={noExpiry} disabled={busy} onChange={(e) => { setNoExpiry(e.target.checked); editAction({ action: "set_expiry", expires_at: e.target.checked || !expiryDate ? null : new Date(`${expiryDate}T23:59:59`).toISOString() }); }} />
                        No expiry
                      </label>
                      {!noExpiry && <button type="button" disabled={busy} onClick={() => editAction({ action: "set_expiry", expires_at: expiryIso() })} className="border border-panel-border rounded px-2 hover:border-gold">Set</button>}
                    </div>
                    {editLink && (
                      <div className="space-y-1">
                        <div className="flex gap-2">
                          <input data-testid="edit-link" readOnly value={editLink} onFocus={(e) => e.currentTarget.select()} className="flex-1 min-w-0 bg-wash-2 border border-panel-border rounded px-2 py-1 text-xs" />
                          <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(editLink); setEditCopied(true); } catch { /* select manually */ } }} className="text-xs border border-panel-border rounded px-2 hover:border-gold">{editCopied ? "Copied" : "Copy"}</button>
                        </div>
                        <div className="text-xs text-muted">This link is only shown now; use Regenerate to get a new one</div>
                      </div>
                    )}
                    <div className="flex gap-2 text-xs">
                      <button type="button" data-testid="edit-regenerate" disabled={busy} onClick={() => editAction({ action: "regenerate" })} className="border border-panel-border rounded px-2 py-1 hover:border-gold">Regenerate edit link</button>
                      <button type="button" disabled={busy} onClick={() => editAction({ action: "disable" })} className="border border-panel-border rounded px-2 py-1 hover:border-gold">Turn off</button>
                    </div>
                  </>
                )}
                {edits.length > 0 && (
                  <ul data-testid="edit-history" className="text-xs space-y-1 max-h-40 overflow-y-auto">
                    {edits.map((ed) => (
                      <li key={ed.id} className="flex items-center justify-between gap-2">
                        <span>{ed.editor}, {ed.created_at} (+{ed.added_chars}/-{ed.removed_chars}){ed.restored_at ? " restored" : ""}</span>
                        <button type="button" disabled={busy} onClick={() => editAction({ action: "restore", log_id: ed.id })} className="underline shrink-0">Restore the version before this edit</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {!token && revoked && <div className="text-xs text-muted">Link revoked. Editing is paused too.</div>}
            {err && <div role="alert" className="text-xs text-red-400">{err}</div>}
          </div>
        </>
      )}
    </div>
  );
}

function DownloadMenu({ id, disabled, inline = false }: { id: number; disabled: boolean; inline?: boolean }) {
  const [open, setOpen] = useState(false);
  const [withTitle, setWithTitle] = useState(true);
  const q = withTitle ? "" : "&title=0";
  const item = "block px-3 py-1.5 hover:bg-wash-2 whitespace-nowrap";
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function downloadPdf() {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/files/${id}/export?format=pdf${q}`);
      if (!res.ok) {
        let m = `PDF download failed (${res.status})`;
        try { m = (await res.json()).error || m; } catch { /* keep default */ }
        setErr(m);
        return;
      }
      const blob = await res.blob();
      const enc = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("content-disposition") || "")?.[1];
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = enc ? decodeURIComponent(enc) : "document.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      setOpen(false);
    } catch (e) {
      setErr(`PDF download failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={inline ? "" : "relative"}>
      {inline ? (
        <button onClick={() => { setErr(""); setOpen((o) => !o); }} disabled={disabled} className={`${MENU_ROW} disabled:opacity-50`} data-testid="download-menu-mobile" aria-haspopup="menu" aria-expanded={open}>
          <FIcon name="download" /> Download
        </button>
      ) : (
        <button onClick={() => { setErr(""); setOpen((o) => !o); }} disabled={disabled} className="hover-pill disabled:opacity-50" data-testid="download-menu" aria-label="Download" title="Download" aria-haspopup="menu" aria-expanded={open}>
          <FIcon name="download" />
        </button>
      )}
      {open && (
        <>
          {!inline && <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />}
          <div role="menu" className={`${inline ? "mt-1 mx-2 w-auto" : "absolute right-0 z-30 mt-2"} bg-panel border border-panel-border rounded-lg shadow-xl py-1 text-sm text-foreground`}>
            <a role="menuitem" className={item} href={`/api/files/${id}/export?format=docx${q}`} download onClick={() => setOpen(false)}>Word (.docx)</a>
            <button role="menuitem" type="button" disabled={busy} className={`${item} w-full text-left disabled:opacity-50`} onClick={downloadPdf}>{busy ? "Making PDF…" : "PDF (.pdf)"}</button>
            {err && <div role="alert" className="px-3 py-1.5 text-xs text-red-400 max-w-xs whitespace-normal">{err}</div>}
            <a role="menuitem" className={item} href={`/api/files/${id}/export?format=md`} download onClick={() => setOpen(false)}>Markdown (.md)</a>
            <label className="flex items-center gap-2 px-3 py-1.5 border-t border-panel-border text-xs text-muted">
              <input type="checkbox" checked={withTitle} onChange={(e) => setWithTitle(e.target.checked)} /> Include page title at top (Word/PDF)
            </label>
          </div>
        </>
      )}
    </div>
  );
}

function MeetingStrip({ meeting }: { meeting: NonNullable<PageView["meeting"]> }) {
  return (
    <div className="mb-6 border border-panel-border rounded-lg p-3 bg-panel/60 flex flex-wrap items-center gap-4 text-xs">
      <span className="text-accent">🎙️ Recorded meeting</span>
      {meeting.duration_sec ? <span className="text-muted">{Math.round(meeting.duration_sec / 60)} min</span> : null}
      {meeting.transcript_source && <span className="text-muted">transcript: {meeting.transcript_source === "browser" ? "live (browser)" : meeting.transcript_source === "openai" ? "Whisper" : "local Whisper"}</span>}
      {meeting.has_audio && (
        <audio controls preload="none" src={`/api/meetings/${meeting.id}/audio`} className="h-8" />
      )}
      <Link href={`/meetings?id=${meeting.id}`} className="ml-auto text-muted hover:text-accent">Open in Meetings →</Link>
    </div>
  );
}

function FilePreview({ view }: { view: PageView }) {
  const p = view.page;
  const src = `/api/files/${p.id}/raw`;
  const mime = p.mime_type || "";
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-xs text-muted">
        <span>{mime || "file"}</span>
        <span>{fmtSize(p.file_size)}</span>
        <a href={`${src}?download=1`} className="ml-auto border border-panel-border rounded px-3 py-1.5 hover:border-gold text-foreground">Download</a>
      </div>
      {mime.startsWith("image/") && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={p.title} className="max-w-full rounded border border-panel-border" />
      )}
      {mime === "application/pdf" && <iframe src={src} title={p.title} className="w-full h-[80vh] rounded border border-panel-border bg-white" />}
      {mime.startsWith("audio/") && <audio controls src={src} className="w-full" />}
      {mime.startsWith("video/") && <video controls src={src} className="w-full rounded" />}
      {p.body && !mime.startsWith("image/") && (
        <pre className="text-xs whitespace-pre-wrap bg-panel border border-panel-border rounded p-4 max-h-[70vh] overflow-auto">{p.body.replace(/^```\n?|\n?```$/g, "")}</pre>
      )}
    </div>
  );
}

function ChildGrid({ items, onOpen }: { items: Child[]; onOpen: (id: number) => void }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {items.map((c) => (
        <button key={c.id} onClick={() => onOpen(c.id)} className="text-left border border-panel-border rounded-lg p-3 hover:border-gold bg-panel/40">
          <div className="flex items-center gap-2">
            <span className="text-lg">{c.icon || defaultIcon(c.kind, c.mime_type)}</span>
            <span className="text-sm font-medium truncate">{c.title}</span>
          </div>
          {c.summary && <div className="text-xs text-muted mt-1.5 line-clamp-2">{c.summary}</div>}
          <div className="text-[11px] text-muted/70 mt-2 flex gap-2 flex-wrap">
            <span>{fmtDate(c.updated_at)}</span>
            {c.tags.slice(0, 3).map((t) => (
              <span key={t}>#{t}</span>
            ))}
          </div>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------- home, search, trash

function Home({ tree, recent, unfiled, onOpen, onTidy, onNew }: { tree: TreeNode[]; recent: TreeNode[]; unfiled: TreeNode[]; onOpen: (id: number) => void; onTidy: () => void; onNew: () => void }) {
  const folders = tree.filter((n) => n.parent_id == null && n.kind === "folder");
  const count = (id: number) => tree.filter((n) => n.parent_id === id).length;
  return (
    <div className="max-w-5xl mx-auto px-4 md:px-12 py-10 space-y-10">
      <div>
        <h1 className="font-display text-3xl tracking-wide">Your workspace</h1>
        <p className="text-sm text-muted mt-1">
          Pages, files and meeting notes, organized for you. Anything you create without picking a folder gets filed by the AI.
          Chief can search and read all of it (<kbd>⌘J</kbd>).
        </p>
      </div>
      {tree.length === 0 && (
        <div className="border border-dashed border-panel-border rounded-lg p-10 text-center text-sm text-muted">
          Nothing here yet. <button onClick={onNew} className="text-accent underline">Create a page</button>, or drop files anywhere on this screen.
        </div>
      )}
      {recent.length > 0 && (
        <section>
          <div className="text-[11px] uppercase tracking-wider text-muted mb-2">Recently edited</div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {recent.map((r) => (
              <button key={r.id} data-testid="files-home-recent-card" onClick={() => onOpen(r.id)} className="text-left border border-panel-border rounded-lg p-3 hover:border-gold bg-panel/40 min-w-0">
                <div className="flex items-start gap-2 min-w-0">
                  <span className="text-base leading-5 shrink-0">{r.icon || defaultIcon(r.kind, r.mime_type)}</span>
                  <span className="text-sm font-medium leading-5 line-clamp-2 break-words min-w-0">{r.title}</span>
                </div>
                <div className="text-[11px] text-muted mt-1.5">{fmtDate(r.updated_at)}</div>
              </button>
            ))}
          </div>
        </section>
      )}
      {folders.length > 0 && (
        <section>
          <div className="text-[11px] uppercase tracking-wider text-muted mb-2">Folders</div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {folders.map((f) => (
              <button key={f.id} data-testid="files-home-folder-card" onClick={() => onOpen(f.id)} className="text-left border border-panel-border rounded-lg p-3 hover:border-gold bg-panel/40 flex items-start gap-2 min-w-0">
                <span className="text-base leading-5 shrink-0">{f.icon || "📁"}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium leading-5 line-clamp-2 break-words">{f.title}</span>
                  <span className="block text-[11px] text-muted mt-0.5">{count(f.id)} items</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {unfiled.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] uppercase tracking-wider text-muted">Unfiled ({unfiled.length})</div>
            <button onClick={onTidy} className="text-xs text-accent hover:underline">✦ Auto-organize these</button>
          </div>
          <div className="border border-panel-border rounded-lg divide-y divide-panel-border">
            {unfiled.slice(0, 12).map((u) => (
              <button key={u.id} onClick={() => onOpen(u.id)} className="w-full text-left px-3 py-2 text-sm hover:bg-wash-1 flex items-center gap-2">
                <span>{u.icon || defaultIcon(u.kind, u.mime_type)}</span>
                <span className="truncate flex-1">{u.title}</span>
                <span className="text-[11px] text-muted">{fmtDate(u.updated_at)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function highlight(snippet: string) {
  return snippet.split(/(«[^»]*»)/g).map((part, i) =>
    part.startsWith("«") ? (
      <mark key={i} className="bg-gold/30 text-foreground rounded px-0.5">
        {part.slice(1, -1)}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function SearchResults({ hits, query, onOpen }: { hits: Hit[]; query: string; onOpen: (id: number) => void }) {
  return (
    <div className="max-w-4xl mx-auto px-4 md:px-12 py-10">
      <div className="text-sm text-muted mb-4">
        {hits.length ? `${hits.length} result${hits.length === 1 ? "" : "s"}` : "No results"} for “{query}”
      </div>
      <div className="space-y-2">
        {hits.map((h) => (
          <button key={h.id} onClick={() => onOpen(h.id)} className="w-full text-left border border-panel-border rounded-lg p-3 hover:border-gold bg-panel/40" data-testid="search-hit">
            <div className="flex items-center gap-2">
              <span>{h.icon || defaultIcon(h.kind)}</span>
              <span className="font-medium text-sm">{h.title}</span>
              <span className="text-[11px] text-muted truncate">{h.path.split(" / ").slice(0, -1).join(" / ")}</span>
            </div>
            {h.snippet && <div className="text-xs text-muted mt-1.5 line-clamp-2">{highlight(h.snippet)}</div>}
            {h.tags.length > 0 && <div className="text-[11px] text-muted/70 mt-1">{h.tags.map((t) => `#${t}`).join(" ")}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

type TrashItem = { id: number; title: string; kind: TreeNode["kind"]; icon: string | null; archived_at: string; inside: number };

function TrashView({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const load = useCallback(async () => setItems((await fetch("/api/files?trash=1").then((r) => r.json())).trash || []), []);
  useEffect(() => {
    load();
  }, [load]);

  async function restore(id: number) {
    await fetch(`/api/files/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ restore: true }) });
    await load();
    onChanged();
  }
  async function forever(item: TrashItem) {
    if (!confirm(`Permanently delete "${item.title}"${item.inside ? ` and the ${item.inside} item${item.inside === 1 ? "" : "s"} inside it` : ""}? This can't be undone.`)) return;
    const res = await fetch(`/api/files/${item.id}?forever=1`, { method: "DELETE" });
    const d = await res.json();
    if (!res.ok) alert(d.error);
    await load();
  }

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-12 py-10">
      <h1 className="font-display text-3xl tracking-wide">Trash</h1>
      <p className="text-sm text-muted mt-1 mb-6">Restore anything here. Nothing is removed for good unless you delete it from this list.</p>
      {items && !items.length && <div className="text-sm text-muted">The Trash is empty.</div>}
      <div className="border border-panel-border rounded-lg divide-y divide-panel-border">
        {items?.map((i) => (
          <div key={i.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <span>{i.icon || defaultIcon(i.kind)}</span>
            <span className="flex-1 truncate">
              {i.title}
              {i.inside > 0 && <span className="text-xs text-muted"> · {i.inside} inside</span>}
            </span>
            <span className="text-[11px] text-muted">{i.archived_at ? fmtDate(i.archived_at) : ""}</span>
            <button onClick={() => restore(i.id)} className="text-xs border border-panel-border rounded px-2 py-1 hover:border-gold">Restore</button>
            <button onClick={() => forever(i)} className="text-xs text-danger hover:underline">Delete forever</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- menus

function ItemMenu({
  node,
  x,
  y,
  onClose,
  onNew,
  onFavorite,
  onRename,
  onMove,
  onAutoFile,
  onTrash,
}: {
  node: TreeNode;
  x: number;
  y: number;
  onClose: () => void;
  onNew: (kind: "page" | "folder") => void;
  onFavorite: () => void;
  onRename: () => void;
  onMove: () => void;
  onAutoFile: () => void;
  onTrash: () => void;
}) {
  const item = (label: string, fn: () => void, cls = "") => (
    <button
      onClick={() => {
        onClose();
        fn();
      }}
      className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-wash-3 ${cls}`}
    >
      {label}
    </button>
  );
  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div className="absolute bg-panel border border-panel-border rounded-lg shadow-xl py-1 w-52" style={{ left: Math.min(x, window.innerWidth - 220), top: Math.min(y, window.innerHeight - 280) }} onClick={(e) => e.stopPropagation()}>
        {node.kind !== "file" && item("New page inside", () => onNew("page"))}
        {node.kind !== "file" && item("New folder inside", () => onNew("folder"))}
        {item("Rename", onRename)}
        {item(node.favorite ? "Remove from favorites" : "Add to favorites", onFavorite)}
        {item("Move to…", onMove)}
        {node.kind !== "folder" && item("✦ File with AI", onAutoFile)}
        <div className="border-t border-panel-border my-1" />
        {item("Move to Trash", onTrash, "text-danger")}
      </div>
    </div>
  );
}

function MoveDialog({ node, tree, onClose, onPick }: { node: TreeNode; tree: TreeNode[]; onClose: () => void; onPick: (parentId: number | null) => void }) {
  const [filter, setFilter] = useState("");
  // Anything that can hold items, except the item itself and what's inside it.
  const blocked = useMemo(() => {
    const out = new Set<number>([node.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of tree) {
        if (n.parent_id && out.has(n.parent_id) && !out.has(n.id)) {
          out.add(n.id);
          grew = true;
        }
      }
    }
    return out;
  }, [node, tree]);
  const pathOf = (n: TreeNode): string => {
    const parts = [n.title];
    let cur = tree.find((t) => t.id === n.parent_id);
    while (cur) {
      parts.unshift(cur.title);
      const pid = cur.parent_id;
      cur = tree.find((t) => t.id === pid);
    }
    return parts.join(" / ");
  };
  const targets = tree
    .filter((n) => n.kind !== "file" && !blocked.has(n.id))
    .map((n) => ({ n, path: pathOf(n) }))
    .filter((t) => t.path.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => (a.n.kind === "folder" ? 0 : 1) - (b.n.kind === "folder" ? 0 : 1) || a.path.localeCompare(b.path));
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-16 md:pt-24" onClick={onClose}>
      <div className="bg-panel border border-panel-border rounded-lg w-[calc(100vw-2rem)] max-w-[28rem] max-h-[60vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-3 border-b border-panel-border">
          <div className="text-sm mb-2">Move “{node.title}” to…</div>
          <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a folder or page…" className="w-full bg-background border border-panel-border rounded px-3 py-2 text-sm outline-none focus:border-gold" />
        </div>
        <div className="overflow-y-auto py-1">
          <button onClick={() => onPick(null)} className="block w-full text-left px-3 py-2 text-sm hover:bg-wash-3">🏠 Top level</button>
          {targets.map(({ n, path }) => (
            <button key={n.id} onClick={() => onPick(n.id)} className="block w-full text-left px-3 py-2 text-sm hover:bg-wash-3 truncate">
              {n.icon || defaultIcon(n.kind)} {path}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
