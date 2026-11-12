import { currentBlocks, type Page } from "./pages";
import { blocksToMarkdown } from "./blocks";
import { lastEdit } from "./page-edit-access";
import { parseMarkdown, toPrintHtml, type Blk, type Run } from "./export";

const okHref = (h?: string) => (h && /^(https?:|mailto:)/i.test(h) ? h : undefined);

function clean(blocks: Blk[]): Blk[] {
  const runs = (rs: Run[]) => rs.map((r) => ({ ...r, href: okHref(r.href) }));
  return blocks.map((b) => (b.k === "h" || b.k === "p" || b.k === "li" || b.k === "quote" ? { ...b, runs: runs(b.runs) } : b));
}

/** Standalone, script-free HTML for the public share route. */
export async function renderSharedHtml(page: Page): Promise<string> {
  let md = page.body || "";
  try {
    md = (await blocksToMarkdown(await currentBlocks(page))) || md;
  } catch {
    /* fall back to the synced markdown body */
  }
  let html = toPrintHtml(clean(parseMarkdown(md)), page.title, page.title);
  const le = lastEdit(page.id);
  if (le) {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    html = html.replace("<body>", `<body><p style="color:#666;font-size:13px">Last edited ${esc(le.created_at)} UTC by ${esc(le.editor)}</p>`);
  }
  const head =
    `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">` +
    `<style>body{max-width:760px;margin:0 auto;padding:32px 20px 64px}</style>`;
  const script = `<script src="/share/${page.share_token}/comments.js" defer></script>`;
  return html.replace("</head>", `${head}${script}</head>`).replace("<body>", `<body data-gl-share="1">`);
}
