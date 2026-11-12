"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BlockNoteSchema, defaultBlockSpecs, filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import { BlockNoteView, type Theme } from "@blocknote/mantine";
import {
  FormattingToolbar,
  FormattingToolbarController,
  SuggestionMenuController,
  blockTypeSelectItems,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
} from "@blocknote/react";
import { calloutBlock } from "./calloutBlock";
import { buildEditorMentionRows } from "@/lib/mention-items";
import { createChiefMentionExtension, refreshChiefBoxes, type ChiefBox } from "./chiefMentionBox";

// The Notion-style block editor for a Files page: slash commands (/), drag handles, headings,
// to-dos, toggles, tables, code, quotes, images and files, colors, links, plus "/Sub-page" to
// nest a new page. Saves itself a moment after Owner stops typing (no Save button).

// @ mentions are links to /files?id=N, /meetings?id=N or /tasks?id=N (see src/lib/mentions.ts,
// which is server-only, so its shape is repeated here).
const MENTION_HREF_RE = /^\/(files|meetings|tasks)\?id=\d+$/;

// Light and dark, matching globals.css; BlockNote picks one from the Mac's appearance setting.
const FONT = "var(--font-montserrat), Montserrat, sans-serif";
const DARK: Theme = {
  colors: {
    editor: { text: "#f2f2f2", background: "transparent" },
    menu: { text: "#f2f2f2", background: "#1a1a1a" },
    tooltip: { text: "#f2f2f2", background: "#262626" },
    hovered: { text: "#f2f2f2", background: "#262626" },
    selected: { text: "#0a0a0a", background: "#d2ae6d" },
    disabled: { text: "#6b6b6b", background: "#1a1a1a" },
    shadow: "#000000",
    border: "#262626",
    sideMenu: "#6b6b6b",
  },
  borderRadius: 6,
  fontFamily: FONT,
};
const LIGHT: Theme = {
  colors: {
    editor: { text: "#1b1b1b", background: "transparent" },
    menu: { text: "#1b1b1b", background: "#ffffff" },
    tooltip: { text: "#1b1b1b", background: "#efece5" },
    hovered: { text: "#1b1b1b", background: "#efece5" },
    selected: { text: "#1b1b1b", background: "#cfa95f" },
    disabled: { text: "#a19d94", background: "#ffffff" },
    shadow: "#c9c4b8",
    border: "#e3e0d8",
    sideMenu: "#a19d94",
  },
  borderRadius: 6,
  fontFamily: FONT,
};
const THEME = { light: LIGHT, dark: DARK };

const schema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, callout: calloutBlock() },
});

async function uploadFile(file: File): Promise<string> {
  const form = new FormData();
  form.set("file", file);
  const res = await fetch("/api/uploads", { method: "POST", body: form });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || "Upload failed");
  return d.url;
}

export default function PageEditor({
  pageId,
  initialBlocks,
  onSaving,
  onSaved,
  onSubPageCreated,
}: {
  pageId: number;
  initialBlocks: unknown[];
  onSaving?: () => void;
  onSaved?: () => void;
  onSubPageCreated?: (id: number) => void;
}) {
  const router = useRouter();
  const editor = useCreateBlockNote(
    {
      schema,
      initialContent: initialBlocks.length ? (initialBlocks as any) : undefined,
      uploadFile,
    },
    [pageId]
  );

  // "@Chief" result boxes: view-only decorations drawn from /api/files/[id]/mentions. They are
  // never part of editor.document, so autosave (below) can't see or alter them.
  const boxes = useRef<ChiefBox[]>([]);
  const ignored = useRef<{ block_id: string | null; norm_text: string }[]>([]);
  const seenUpdated = useRef<string | null>(null);
  const ownSave = useRef(false);
  const loadBoxes = useCallback(async () => {
    try {
      const res = await fetch(`/api/files/${pageId}/mentions`);
      if (!res.ok) return;
      const d = await res.json();
      boxes.current = Array.isArray(d.mentions) ? d.mentions : [];
      ignored.current = Array.isArray(d.ignored) ? d.ignored : [];
      refreshChiefBoxes((editor as any)._tiptapEditor?.view);
      // Pull in server-side edits (e.g. an @Chief insert) when Owner has no unsaved typing, so a
      // stale tab can't autosave over them.
      const stamp = typeof d.page_updated_at === "string" ? d.page_updated_at : null;
      if (stamp) {
        if (ownSave.current || seenUpdated.current === null) {
          ownSave.current = false;
          seenUpdated.current = stamp;
        } else if (stamp !== seenUpdated.current && !dirty.current) {
          const pr = await fetch(`/api/files/${pageId}`);
          if (pr.ok && !dirty.current) {
            const pd = await pr.json();
            const blocks = Array.isArray(pd.blocks) ? pd.blocks : Array.isArray(pd.page?.blocks) ? pd.page.blocks : null;
            if (blocks && blocks.length) editor.replaceBlocks(editor.document, blocks);
            seenUpdated.current = stamp;
          }
        }
      }
    } catch {
      /* the boxes are optional; the page works without them */
    }
  }, [editor, pageId]);
  const loadBoxesRef = useRef(loadBoxes);
  useEffect(() => {
    loadBoxesRef.current = loadBoxes;
  }, [loadBoxes]);

  useEffect(() => {
    boxes.current = [];
    ignored.current = [];
    const retry = async (mentionId: number) => {
      await fetch(`/api/files/${pageId}/mentions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mention_id: mentionId, action: "retry" }),
      });
      loadBoxesRef.current();
    };
    try {
      editor.registerExtension(createChiefMentionExtension(() => boxes.current, retry, () => ignored.current) as any);
    } catch {
      /* decorations unavailable: the page still edits normally */
    }
    let stopped = false;
    let t: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await loadBoxesRef.current();
      if (stopped) return;
      const active = boxes.current.some((b) => b.status === "waiting" || b.status === "running");
      t = setTimeout(poll, active ? 15_000 : 60_000);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(t);
      try {
        editor.unregisterExtension("chiefMentionBox");
      } catch {
        /* already gone */
      }
    };
  }, [editor, pageId]);

  // Debounced autosave; also flushed when leaving the page so nothing typed is lost.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const saveNow = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    onSaving?.();
    const res = await fetch(`/api/files/${pageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: editor.document, base_updated_at: seenUpdated.current }),
      keepalive: true,
    });
    if (res.status === 409) {
      // The page changed elsewhere since this tab loaded it: reload instead of overwriting.
      try {
        const pr = await fetch(`/api/files/${pageId}`);
        if (pr.ok) {
          const pd = await pr.json();
          if (Array.isArray(pd.blocks) && pd.blocks.length) editor.replaceBlocks(editor.document, pd.blocks);
          seenUpdated.current = pd.page?.updated_at ?? null;
        }
      } catch {
        /* next poll will pick it up */
      }
      dirty.current = false;
      onSaved?.();
      loadBoxesRef.current();
      return;
    }
    try {
      const saved = await res.json();
      if (typeof saved?.page?.updated_at === "string") seenUpdated.current = saved.page.updated_at;
    } catch {
      /* keepalive on unload: no response to read */
    }
    onSaved?.();
    ownSave.current = true;
    loadBoxesRef.current();
  }, [editor, pageId, onSaving, onSaved]);
  const save = useRef(saveNow);
  useEffect(() => {
    save.current = saveNow;
  }, [saveNow]);

  useEffect(() => {
    const flush = () => save.current();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      if (timer.current) clearTimeout(timer.current);
      flush();
    };
  }, [pageId]);

  function onChange() {
    dirty.current = true;
    onSaving?.();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save.current(), 800);
  }

  async function createSubPage() {
    const res = await fetch("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Untitled", parent_id: pageId }),
    });
    const d = await res.json();
    if (!res.ok) return;
    editor.insertInlineContent([{ type: "link", href: `/files?id=${d.page.id}`, content: "📄 Untitled" }, " "]);
    onSubPageCreated?.(d.page.id);
  }

  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<
    { id: number; source: string; agent_slug: string | null; created_at: string; length: number; title: string | null }[]
  >([]);
  async function toggleHistory() {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (!next) return;
    try {
      const res = await fetch(`/api/files/${pageId}/versions`);
      if (res.ok) setVersions((await res.json()).versions || []);
    } catch {
      /* history is optional */
    }
  }
  async function restoreVersion(versionId: number) {
    if (!window.confirm("Restore this version? The current text is kept in history.")) return;
    const res = await fetch(`/api/files/${pageId}/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version_id: versionId }),
    });
    if (res.ok) window.location.reload();
  }

  return (
    <div
      className="page-editor -mx-4 md:-mx-12"
      data-testid="page-editor"
      onClickCapture={(e) => {
        // Links to other pages in Files open them in place, like Notion.
        const a = (e.target as HTMLElement).closest("a");
        const href = a?.getAttribute("href") || "";
        if (MENTION_HREF_RE.test(href) || href.startsWith("/files")) {
          e.preventDefault();
          e.stopPropagation();
          save.current().then(() => router.push(href));
        }
      }}
    >
      <div className="px-4 md:px-12 pb-1 text-xs text-gray-500">
        <button type="button" data-testid="page-history-toggle" className="underline" onClick={toggleHistory}>
          {historyOpen ? "Hide history" : "History"}
        </button>
        {historyOpen && (
          <ul data-testid="page-history-list" className="mt-1 space-y-1">
            {versions.length === 0 && <li>No earlier versions yet.</li>}
            {versions.map((v) => (
              <li key={v.id} className="flex items-center gap-2">
                <span>
                  {v.created_at} · {v.source}
                  {v.agent_slug ? ` (${v.agent_slug})` : ""} · {v.length ?? 0} chars
                </span>
                <button type="button" className="underline" onClick={() => restoreVersion(v.id)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <BlockNoteView editor={editor} theme={THEME} onChange={onChange} slashMenu={false} formattingToolbar={false}>
        <FormattingToolbarController
          formattingToolbar={() => (
            <FormattingToolbar
              blockTypeSelectItems={[
                ...blockTypeSelectItems(editor.dictionary),
                {
                  name: "Callout",
                  type: "callout",
                  props: {},
                  icon: (() => <span>💡</span>) as any,
                  isSelected: (b: any) => b.type === "callout",
                } as any,
              ]}
            />
          )}
        />
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                {
                  title: "Callout",
                  subtext: "Make writing stand out",
                  aliases: ["callout", "note", "tip", "info", "box", "highlight"],
                  group: "Basic blocks",
                  icon: <span className="text-base">💡</span>,
                  onItemClick: () => insertOrUpdateBlockForSlashMenu(editor as any, { type: "callout" } as any),
                },
                {
                  title: "Sub-page",
                  subtext: "Nest a new page inside this one",
                  aliases: ["page", "subpage", "child"],
                  group: "Pages",
                  icon: <span className="text-base">📄</span>,
                  onItemClick: createSubPage,
                },
                ...getDefaultReactSlashMenuItems(editor),
              ],
              query
            )
          }
        />
        <SuggestionMenuController
          triggerCharacter="@"
          getItems={async (query) => {
            const q = query.trim();
            const items: any[] = [];
            if (!/\s/.test(query) && "chief".startsWith(q.toLowerCase())) {
              items.push({
                title: "Chief",
                subtext: "Give Chief an action; he'll act after 10 min of no edits",
                group: "Assistant",
                icon: <span className="text-base">🤖</span>,
                onItemClick: () => editor.insertInlineContent("@Chief "),
              });
            }
            try {
              const res = await fetch(`/api/mentions?q=${encodeURIComponent(q)}`);
              const d = res.ok ? await res.json() : { items: [] };
              for (const r of buildEditorMentionRows(d.items || [])) {
                items.push({
                  title: r.title,
                  subtext: r.subtext,
                  group: r.group,
                  icon: <span className="text-base">{r.icon}</span>,
                  onItemClick: () => editor.insertInlineContent([{ type: "link", href: r.url, content: `@${r.text}` }, " "]),
                });
              }
            } catch {
              /* picker just shows what it has */
            }
            return items;
          }}
        />
      </BlockNoteView>
    </div>
  );
}
