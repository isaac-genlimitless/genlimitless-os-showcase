import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { absoluteFilePath, getPage } from "@/lib/pages";

// Serves an uploaded file (inline, so PDFs and images preview in the browser).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const page = getPage(Number((await params).id));
  const file = page && absoluteFilePath(page);
  if (!page || !file || !fs.existsSync(file)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const mime = page.mime_type || "application/octet-stream";
  // Only types the browser previews safely are shown inline; anything that could run as a page
  // on the OS's origin (HTML, SVG, XML, unknown) is sandboxed and downloaded instead.
  const previewable = /^(image\/(png|jpe?g|gif|webp|avif)|application\/pdf|audio\/|video\/|text\/plain)/.test(mime);
  const download = !!req.nextUrl.searchParams.get("download") || !previewable;
  return new NextResponse(fs.readFileSync(file), {
    headers: {
      "Content-Type": previewable ? mime : "application/octet-stream",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(page.title)}`,
      "X-Content-Type-Options": "nosniff",
      ...(previewable ? {} : { "Content-Security-Policy": "sandbox" }),
    },
  });
}
