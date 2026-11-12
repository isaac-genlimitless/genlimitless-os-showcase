"use client";

import { useMemo, useState } from "react";
import { FIcon } from "./FilesIcons";
import { defaultIcon, type TreeNode } from "./types";

// The workspace tree in the Files sidebar: nested folders and pages, drag an item onto another
// to nest it (or onto "Workspace" for the top level), hover for + (new page inside) and ⋯.

export type TreeActions = {
  open: (id: number) => void;
  newInside: (parentId: number | null, kind: "page" | "folder") => void;
  move: (id: number, parentId: number | null) => void;
  menu: (node: TreeNode, anchor: DOMRect) => void;
  uploadInto: (parentId: number | null, files: FileList) => void;
};

type RowCtx = {
byParent: Map<number | null, TreeNode[]>;
selectedId: number | null;
expanded: Set<number>;
toggle: (id: number, open?: boolean) => void;
actions: TreeActions;
dropTarget: number | "root" | null;
setDropTarget: React.Dispatch<React.SetStateAction<number | "root" | null>>;
onDrop: (e: React.DragEvent, parentId: number | null) => void;
};

function Row({ n, depth, ctx }: { n: TreeNode; depth: number; ctx: RowCtx }) {
const { byParent, selectedId, expanded, toggle, actions, dropTarget, setDropTarget, onDrop } = ctx;
  const kids = byParent.get(n.id) || [];
  const open = expanded.has(n.id);
  const canContain = n.kind !== "file";
  return (
    <div>
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/x-os-page", String(n.id));
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!canContain) return;
          e.preventDefault();
          setDropTarget(n.id);
        }}
        onDragLeave={() => setDropTarget((t) => (t === n.id ? null : t))}
        onDrop={(e) => canContain && onDrop(e, n.id)}
        data-testid={`tree-item-${n.id}`}
        className={`group flex items-center gap-1 pr-1 py-1 rounded cursor-pointer text-sm ${
          selectedId === n.id ? "bg-wash-3 text-accent" : "hover:bg-wash-1 text-foreground/85"
        } ${dropTarget === n.id ? "ring-1 ring-gold" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => actions.open(n.id)}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggle(n.id);
          }}
          aria-label={open ? "Collapse" : "Expand"}
          className={`w-5 h-5 shrink-0 flex items-center justify-center text-[15px] leading-none text-muted hover:text-foreground ${kids.length || n.kind === "folder" ? "" : "invisible"}`}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className="w-5 shrink-0 text-center">{n.icon || defaultIcon(n.kind, n.mime_type)}</span>
        <span className="truncate flex-1">{n.title}</span>
        {n.placed_by === "ai" && <span className="text-[9px] text-accent/60 opacity-0 group-hover:opacity-100" title="Filed by AI">AI</span>}
        <button
          onClick={(e) => {
            e.stopPropagation();
            actions.menu(n, (e.currentTarget as HTMLElement).getBoundingClientRect());
          }}
          aria-label={`Actions for ${n.title}`}
          className="opacity-0 group-hover:opacity-100 text-muted hover:text-foreground px-1"
        >
          ⋯
        </button>
        {canContain && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggle(n.id, true);
              actions.newInside(n.id, "page");
            }}
            aria-label={`New page in ${n.title}`}
            title="New page inside"
            className="opacity-0 group-hover:opacity-100 text-muted hover:text-foreground px-1"
          >
            +
          </button>
        )}
      </div>
      {open && kids.map((k) => <Row key={k.id} n={k} depth={depth + 1} ctx={ctx} />)}
      {open && !kids.length && n.kind === "folder" && (
        <div className="text-xs text-muted/60 py-1" style={{ paddingLeft: 30 + depth * 14 }}>
          Empty
        </div>
      )}
    </div>
  );
}


export function FilesTree({
  nodes,
  selectedId,
  expanded,
  toggle,
  actions,
}: {
  nodes: TreeNode[];
  selectedId: number | null;
  expanded: Set<number>;
  toggle: (id: number, open?: boolean) => void;
  actions: TreeActions;
}) {
  const byParent = useMemo(() => {
    const m = new Map<number | null, TreeNode[]>();
    for (const n of nodes) {
      const k = n.parent_id ?? null;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(n);
    }
    return m;
  }, [nodes]);
  const [dropTarget, setDropTarget] = useState<number | "root" | null>(null);

  function onDrop(e: React.DragEvent, parentId: number | null) {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    if (e.dataTransfer.files.length) return actions.uploadInto(parentId, e.dataTransfer.files);
    const id = Number(e.dataTransfer.getData("text/x-os-page"));
    if (id && id !== parentId) {
      actions.move(id, parentId);
      if (parentId) toggle(parentId, true);
    }
  }

  const favorites = nodes.filter((n) => n.favorite);
  const roots = byParent.get(null) || [];

  return (
    <div className="text-sm">
      {favorites.length > 0 && (
        <div className="mb-3">
          <div className="px-2 py-1 text-[11px] uppercase tracking-wider text-muted">Favorites</div>
          {favorites.map((n) => (
            <div
              key={`fav-${n.id}`}
              onClick={() => actions.open(n.id)}
              className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer ${selectedId === n.id ? "bg-wash-3 text-accent" : "hover:bg-wash-1"}`}
            >
              <span className="w-5 text-center">{n.icon || defaultIcon(n.kind, n.mime_type)}</span>
              <span className="truncate">{n.title}</span>
            </div>
          ))}
        </div>
      )}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDropTarget("root");
        }}
        onDragLeave={() => setDropTarget((t) => (t === "root" ? null : t))}
        onDrop={(e) => onDrop(e, null)}
        className={`px-2 py-1 text-[11px] uppercase tracking-wider text-muted flex items-center justify-between rounded ${dropTarget === "root" ? "ring-1 ring-gold" : ""}`}
      >
        <span>Workspace</span>
        <span className="normal-case tracking-normal flex gap-2">
          <button onClick={() => actions.newInside(null, "folder")} className="hover-pill" aria-label="New folder" title="New folder">
            <FIcon name="folder-plus" />
          </button>
        </span>
      </div>
      {roots.length === 0 && <div className="px-2 py-2 text-xs text-muted">Nothing here yet.</div>}
      {roots.map((n) => (
        <Row key={n.id} n={n} depth={0} ctx={{ byParent, selectedId, expanded, toggle, actions, dropTarget, setDropTarget, onDrop }} />
      ))}
    </div>
  );
}
