import type { ServerBlockNoteEditor } from "@blocknote/server-util";
import type { JSDOM } from "jsdom";
import { calloutConfig } from "./calloutBlock";

// Server-side conversion between the page editor's blocks and markdown, so agents can read and
// write pages as markdown while Owner edits the same page as rich blocks.
//
// Loaded lazily with import(): BlockNote's CommonJS build doesn't load in plain Node, so a static
// import would break anything that pulls this module in through require (e.g. specs importing
// src/lib directly). The conversions themselves are synchronous once loaded; they only need a DOM
// on globalThis while they run, which is borrowed and restored within the same tick.

type Server = {
  editor: ServerBlockNoteEditor["editor"];
  dom: JSDOM;
  toMarkdown: typeof import("@blocknote/core").blocksToMarkdown;
};
type AnyBlocks = Parameters<ServerBlockNoteEditor["blocksToMarkdownLossy"]>[0];

let loading: Promise<Server> | null = null;
function server(): Promise<Server> {
  loading ??= (async () => {
    const [{ ServerBlockNoteEditor }, core, { JSDOM }] = await Promise.all([import("@blocknote/server-util"), import("@blocknote/core"), import("jsdom")]);
    const schema = core.BlockNoteSchema.create({
      blockSpecs: {
        ...core.defaultBlockSpecs,
        callout: core.createBlockSpec(calloutConfig, {
          render: (block) => {
            const dom = document.createElement("div");
            const icon = document.createElement("span");
            icon.textContent = block.props.icon;
            const contentDOM = document.createElement("div");
            dom.append(icon, contentDOM);
            return { dom, contentDOM };
          },
          toExternalHTML: (block) => {
            const dom = document.createElement("blockquote");
            const p = document.createElement("p");
            p.append(document.createTextNode(`${block.props.icon} `));
            const contentDOM = document.createElement("span");
            p.append(contentDOM);
            dom.append(p);
            return { dom, contentDOM };
          },
        })(),
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- custom schema generics
    return { editor: ServerBlockNoteEditor.create({ schema } as any).editor as any, dom: new JSDOM(), toMarkdown: core.blocksToMarkdown };
  })();
  return loading;
}

function withDom<T>(s: Server, fn: () => T): T {
  const g = globalThis as { window?: unknown; document?: unknown };
  const prevWindow = g.window;
  const prevDocument = g.document;
  g.window = s.dom.window;
  g.document = s.dom.window.document;
  try {
    return fn();
  } finally {
    g.window = prevWindow;
    g.document = prevDocument;
  }
}

export async function markdownToBlocks(markdown: string): Promise<unknown[]> {
  if (!markdown.trim()) return [];
  const s = await server();
  const blocks = withDom(s, () => s.editor.tryParseMarkdownToBlocks(markdown)) as unknown[];
  return blocks.map(quoteToCallout);
}

// A freshly parsed "> 💡 text" quote becomes a callout (icon 💡, gray). Stored blocks never pass
// through here, so existing quotes are untouched.
const ICON_PREFIX = /^(\p{Extended_Pictographic}️?) /u;
type AnyBlock = { type?: string; props?: Record<string, unknown>; content?: unknown; children?: unknown[] };
function quoteToCallout(raw: unknown): unknown {
  const b = raw as AnyBlock;
  if (!b || typeof b !== "object") return raw;
  const children = Array.isArray(b.children) ? b.children.map(quoteToCallout) : b.children;
  if (b.type === "quote" && Array.isArray(b.content) && b.content.length) {
    const first = b.content[0] as { type?: string; text?: string };
    const m = first?.type === "text" && typeof first.text === "string" ? ICON_PREFIX.exec(first.text) : null;
    if (m) {
      const rest = first.text!.slice(m[0].length);
      const content = [...(rest ? [{ ...first, text: rest }] : []), ...b.content.slice(1)];
      return { ...b, type: "callout", props: { icon: m[1], color: "gray" }, content, children };
    }
  }
  return children === b.children ? b : { ...b, children };
}

export async function blocksToMarkdown(blocks: unknown[]): Promise<string> {
  if (!blocks.length) return "";
  const s = await server();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's schema generics don't line up across its own packages
  return withDom(s, () => s.toMarkdown(blocks as AnyBlocks, s.editor.pmSchema, s.editor as any, { document: s.dom.window.document })).trim();
}
