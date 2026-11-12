import { Plugin, PluginKey } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

// The "@Chief" result box shown right under the line Owner wrote it on. It is a ProseMirror WIDGET
// DECORATION: a view-only overlay that never enters the document, so it is not in
// editor.document, never reaches the autosave PATCH, and typing can't alter or save it. The
// content comes from /api/files/[id]/mentions (page_mentions table). The DOM is built with
// createElement + textContent only (agent-written text is never parsed as HTML).

export type ChiefBox = {
  id: number;
  status: "waiting" | "running" | "done" | "error";
  block_id: string | null;
  norm_text: string;
  summary: string | null;
  links: { label: string; href: string }[];
  error: string | null;
  run_id: number | null;
};

export const chiefBoxKey = new PluginKey("chiefMentionBox");

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = style;
  if (text !== undefined) e.textContent = text;
  return e;
}

function buildBox(b: ChiefBox, onRetry: (id: number) => void): HTMLElement {
  const box = el(
    "div",
    "display:none;position:fixed;z-index:60;width:min(360px, calc(100vw - 24px));box-sizing:border-box;padding:8px 12px;" +
      "border:1px solid var(--panel-border);border-left:3px solid var(--gold);border-radius:4px;" +
      "background:color-mix(in srgb, var(--gold) 12%, var(--panel));color:var(--foreground);box-shadow:0 4px 16px rgba(0,0,0,.25);" +
      "font-size:13px;line-height:1.45;font-weight:400;text-decoration:none;text-align:left;white-space:normal;overflow-wrap:anywhere;user-select:text;"
  );
  box.setAttribute("contenteditable", "false");
  box.setAttribute("data-testid", "chief-mention-box");
  box.setAttribute("data-status", b.status);
  box.setAttribute("data-mention-id", String(b.id));

  const label = (t: string) => box.appendChild(el("span", "font-weight:600;", t));
  if (b.status === "waiting") {
    label("Chief: ");
    box.appendChild(document.createTextNode("will look at this after 10 min without edits"));
  } else if (b.status === "running") {
    label("Chief is on it…");
  } else if (b.status === "done") {
    label("Chief: ");
    box.appendChild(document.createTextNode(b.summary || "Done."));
    if (b.links.length) {
      const row = el("div", "display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;");
      for (const l of b.links) {
        const a = el("a", "padding:1px 8px;border:1px solid var(--gold);border-radius:999px;font-size:12px;text-decoration:none;color:inherit;", l.label);
        a.setAttribute("href", l.href);
        a.setAttribute("data-testid", "chief-mention-link");
        row.appendChild(a);
      }
      box.appendChild(row);
    }
  } else {
    label("Chief couldn't finish: ");
    box.appendChild(document.createTextNode(b.error || "unknown error"));
    const btn = el("button", "display:block;margin-top:6px;padding:1px 10px;border:1px solid var(--gold);border-radius:4px;font-size:12px;cursor:pointer;background:transparent;color:inherit;", "Retry");
    btn.setAttribute("type", "button");
    btn.setAttribute("data-testid", "chief-mention-retry");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      onRetry(b.id);
    });
    box.appendChild(btn);
  }
  if (b.run_id && (b.status === "done" || b.status === "error")) {
    const a = el("a", "display:inline-block;margin-top:6px;font-size:11px;opacity:.7;color:inherit;", "See what Chief did");
    a.setAttribute("href", `/team?view=activity&run=${b.run_id}`);
    box.appendChild(a);
  }
  return box;
}

// Copy of the detection regex in chief-mentions.ts.
const MENTION_RE = /(?<![\w.@])@chief(?![\w-]|\.\w)/i;
// Same shape as parseMentionHref in src/lib/mentions.ts (that file is server-only).
const MENTION_HREF_RE = /^\/(files|meetings|tasks)\?id=\d+$/;
// "Active" = Chief has picked it up or acted on it.
const ACTIVE = new Set(["running", "done", "error"]);

/** Document range of the @Chief word in a line, or null if it is not there. Code-marked text is ignored. */
function mentionRange(firstChild: PMNode, contentStart: number): { from: number; to: number } | null {
  let str = "";
  const map: number[] = []; // string index -> document position
  firstChild.descendants((node, pos) => {
    if (node.isText) {
      // Code text and @-mention chips (links to /tasks?id=N etc.) never count as an @Chief action.
      const isCode = node.marks.some(
        (m) => m.type.name === "code" || (m.type.name === "link" && MENTION_HREF_RE.test(String(m.attrs?.href ?? "")))
      );
      const t = node.text || "";
      for (let i = 0; i < t.length; i++) {
        str += isCode ? " " : t[i];
        map.push(contentStart + pos + i);
      }
    } else if (node.isInline) {
      for (let i = 0; i < node.nodeSize; i++) {
        str += " ";
        map.push(contentStart + pos + i);
      }
    }
    return true;
  });
  const m = MENTION_RE.exec(str);
  if (!m) return null;
  return { from: map[m.index], to: map[m.index + m[0].length - 1] + 1 };
}

function buildAnchor(b: ChiefBox, onRetry: (id: number) => void): HTMLElement {
  const a = document.createElement("span");
  a.setAttribute("data-chief-anchor", String(b.id));
  a.setAttribute("contenteditable", "false");
  a.appendChild(buildBox(b, onRetry));
  return a;
}

/** A BlockNote extension (key + prosemirrorPlugins) that draws the mention highlight + hover card.
 *  `getBoxes` is read on every render; call refreshChiefBoxes(view) after the data changes. */
export type IgnoredMention = { block_id: string | null; norm_text: string };

export function createChiefMentionExtension(
  getBoxes: () => ChiefBox[],
  onRetry: (id: number) => void,
  getIgnored?: () => IgnoredMention[]
) {
  const plugin = new Plugin({
    key: chiefBoxKey,
    view(editorView) {
      const dom = editorView.dom as HTMLElement;
      let openId: string | null = null;
      let closeTimer: ReturnType<typeof setTimeout> | null = null;
      let lastTouch = 0;
      const recentTouch = () => Date.now() - lastTouch < 800;
      const idFrom = (t: EventTarget | null): string | null => {
        const e = t instanceof Element ? t.closest("[data-chief-mention-id],[data-chief-anchor]") : null;
        return e ? e.getAttribute("data-chief-mention-id") ?? e.getAttribute("data-chief-anchor") : null;
      };
      const cardOf = (id: string) => dom.querySelector<HTMLElement>(`[data-chief-anchor="${id}"] [data-testid="chief-mention-box"]`);
      const mentionOf = (id: string) => dom.querySelector<HTMLElement>(`[data-chief-mention-id="${id}"]`);
      const clearTimer = () => {
        if (closeTimer) clearTimeout(closeTimer);
        closeTimer = null;
      };
      const hideAll = () => {
        dom.querySelectorAll<HTMLElement>('[data-testid="chief-mention-box"]').forEach((c) => (c.style.display = "none"));
        openId = null;
      };
      const place = (id: string) => {
        const card = cardOf(id);
        const men = mentionOf(id);
        if (!card || !men) return false;
        card.style.display = "block";
        const r = men.getBoundingClientRect();
        const ch = card.offsetHeight;
        const cw = card.offsetWidth;
        let left = Math.min(r.left, window.innerWidth - cw - 8);
        left = Math.max(8, left);
        let top = r.bottom + 4;
        if (top + ch > window.innerHeight - 8 && r.top - 4 - ch >= 8) top = r.top - 4 - ch;
        card.style.left = `${left}px`;
        card.style.top = `${top}px`;
        return true;
      };
      const show = (id: string) => {
        clearTimer();
        if (openId !== id) hideAll();
        if (place(id)) openId = id;
        else hideAll();
      };
      const scheduleHide = () => {
        clearTimer();
        closeTimer = setTimeout(hideAll, 200);
      };
      const onOver = (e: MouseEvent) => {
        if (recentTouch()) return;
        const id = idFrom(e.target);
        if (!id) return;
        if (openId === id) clearTimer();
        else show(id);
      };
      const onOut = (e: MouseEvent) => {
        if (recentTouch()) return;
        if (idFrom(e.target)) scheduleHide();
      };
      const onPointerDown = (e: PointerEvent) => {
        if (e.pointerType !== "touch") return;
        lastTouch = Date.now();
        if (!idFrom(e.target)) hideAll();
      };
      const onClick = (e: MouseEvent) => {
        if (!recentTouch()) return;
        const t = e.target as Element | null;
        if (t && t.closest("[data-chief-anchor]") && t.closest("a,button")) return;
        const id = idFrom(e.target);
        if (!id) return;
        if (openId === id) hideAll();
        else show(id);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") hideAll();
      };
      const onMove = () => {
        if (openId) place(openId);
      };
      const onDocTouch = (e: PointerEvent) => {
        if (e.pointerType === "touch" && openId && !idFrom(e.target)) hideAll();
      };
      dom.addEventListener("mouseover", onOver);
      dom.addEventListener("mouseout", onOut);
      dom.addEventListener("pointerdown", onPointerDown);
      dom.addEventListener("click", onClick);
      document.addEventListener("pointerdown", onDocTouch);
      document.addEventListener("keydown", onKey);
      window.addEventListener("scroll", onMove, { capture: true, passive: true });
      window.addEventListener("resize", onMove);
      return {
        update() {
          if (openId) show(openId);
        },
        destroy() {
          clearTimer();
          dom.removeEventListener("mouseover", onOver);
          dom.removeEventListener("mouseout", onOut);
          dom.removeEventListener("pointerdown", onPointerDown);
          dom.removeEventListener("click", onClick);
          document.removeEventListener("pointerdown", onDocTouch);
          document.removeEventListener("keydown", onKey);
          window.removeEventListener("scroll", onMove, { capture: true } as EventListenerOptions);
          window.removeEventListener("resize", onMove);
        },
      };
    },
    props: {
      decorations(state) {
        const boxes = getBoxes();
        const ignored = getIgnored?.() ?? [];
        // Candidate blocks: the first child of each blockContainer (the line's own content).
        const blocks: { id: string | null; end: number; text: string; range: { from: number; to: number } | null }[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name === "blockContainer" && node.firstChild) {
            blocks.push({
              id: (node.attrs as any).id ?? null,
              end: pos + 1 + node.firstChild.nodeSize,
              text: norm(node.firstChild.textContent),
              range: mentionRange(node.firstChild, pos + 2),
            });
          }
          return true;
        });
        const used = new Set<number>();
        const decos: Decoration[] = [];
        for (const b of boxes) {
          const hit =
            blocks.find((x) => x.range && !used.has(x.end) && b.block_id && x.id === b.block_id) ||
            blocks.find((x) => x.range && !used.has(x.end) && x.text.includes("@chief") && (x.text === b.norm_text || x.text.includes(b.norm_text)));
          if (!hit || !hit.range) continue;
          used.add(hit.end);
          const range = hit.range;
          decos.push(
            Decoration.inline(
              range.from,
              range.to,
              {
                class: ACTIVE.has(b.status) ? "chief-mention chief-mention-active" : "chief-mention chief-mention-pending",
                "data-chief-mention-id": String(b.id),
              },
              { inclusiveStart: false, inclusiveEnd: false }
            ),
            Decoration.widget(range.to, () => buildAnchor(b, onRetry), {
              side: -1,
              key: `chief:${b.id}:${b.status}:${b.summary ?? ""}:${b.error ?? ""}:${b.links.length}`,
              ignoreSelection: true,
              stopEvent: () => true,
            })
          );
        }
        // Freshly typed @Chief with no row yet: blue straight away (unless the server ignores that line).
        for (const x of blocks) {
          if (!x.range || used.has(x.end)) continue;
          if (ignored.some((i) => i.block_id === x.id && i.norm_text === x.text)) continue;
          decos.push(Decoration.inline(x.range.from, x.range.to, { class: "chief-mention-pending" }, { inclusiveStart: false, inclusiveEnd: false }));
        }
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
  return { key: "chiefMentionBox", prosemirrorPlugins: [plugin] } as const;
}

/** Re-draw after the mentions data changed. A meta-only transaction: it doesn't touch the document. */
export function refreshChiefBoxes(view: EditorView | undefined | null) {
  if (!view || (view as any).isDestroyed) return;
  view.dispatch(view.state.tr.setMeta(chiefBoxKey, Date.now()).setMeta("addToHistory", false));
}
