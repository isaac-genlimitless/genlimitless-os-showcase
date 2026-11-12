import { NextRequest, NextResponse } from "next/server";
import { currentBlocks, getPage } from "@/lib/pages";
import { blocksToMarkdown } from "@/lib/blocks";
import { exportFileName, parseMarkdown, toDocx, toPrintHtml } from "@/lib/export";
import { htmlToPdf } from "@/lib/pdf";
import { simplePdf } from "@/lib/simple-pdf";

// Read-only: GET /api/files/:id/export?format=md|docx|pdf[&title=1|0]. Never writes, sends or deletes.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const page = getPage(Number((await params).id));
  if (!page) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (page.kind === "folder" || page.kind === "file")
    return NextResponse.json({ error: "Only pages can be exported; uploaded files have their own Download button." }, { status: 400 });
  const format = req.nextUrl.searchParams.get("format") ?? "md";
  if (!["md", "docx", "pdf"].includes(format)) return NextResponse.json({ error: "format must be md, docx or pdf" }, { status: 400 });
  const t = req.nextUrl.searchParams.get("title");
  const withTitle = t === null ? true : t === "1"; // Every format includes the page title by default; ?title=0 opts out.

  let md = page.body || "";
  try {
    md = (await blocksToMarkdown(await currentBlocks(page))) || md;
  } catch {
    /* fall back to the synced markdown body */
  }
  // Don't double the title when the body already opens with it (ignores #, bold, case, spacing).
  const norm = (s: string) => s.replace(/^[#>\s*_]+|[\s*_]+$/g, "").replace(/\s+/g, " ").toLowerCase();
  const firstLine = md.split("\n").find((l) => l.trim()) ?? "";
  const showTitle = withTitle && norm(firstLine) !== norm(page.title);
  const name = exportFileName(page.title);
  const disp = (kind: "attachment" | "inline", ext: string) => {
    const ascii = `${name}.${ext}`.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    const utf8 = encodeURIComponent(`${name}.${ext}`).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
  };
  const base = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };

  if (format === "md") {
    const text = showTitle ? `# ${page.title}\n\n${md}\n` : `${md}\n`;
    return new NextResponse(text, { headers: { ...base, "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": disp("attachment", "md") } });
  }
  const blocks = parseMarkdown(md);
  if (format === "docx") {
    return new NextResponse(new Uint8Array(toDocx(blocks, showTitle ? page.title : undefined)), {
      headers: { ...base, "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Content-Disposition": disp("attachment", "docx") },
    });
  }
  const html = toPrintHtml(blocks, name, showTitle ? page.title : undefined, { forPdf: true });
  let pdf: Buffer;
  let engine = "chromium";
  try {
    pdf = await htmlToPdf(html);
  } catch (e) {
    console.error("[pdf] Chromium unavailable, using built-in PDF writer:", (e as Error).message);
    try {
      pdf = simplePdf(blocks, showTitle ? page.title : undefined);
      engine = "builtin";
    } catch (e2) {
      return NextResponse.json({ error: `PDF failed: ${(e2 as Error).message}` }, { status: 500 });
    }
  }
  return new NextResponse(new Uint8Array(pdf), {
    headers: { ...base, "Content-Type": "application/pdf", "Content-Disposition": disp("attachment", "pdf"), "X-PDF-Engine": engine },
  });
}
