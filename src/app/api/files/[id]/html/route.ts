import { NextRequest, NextResponse } from "next/server";
import { getPage, pageTags } from "@/lib/pages";

const MAX_BYTES = 1.5 * 1024 * 1024;

// Serves the ```html block of a page tagged "html-diagram" as a sandboxed, script-free document.
// The CSP "sandbox" (no allow-scripts, no allow-same-origin) gives an opaque origin and blocks all
// scripts, so it can never touch the OS origin or cookies, even if opened directly in a tab.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const page = getPage(Number((await params).id));
  if (!page || page.status === "archived" || !pageTags(page).includes("html-diagram")) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = String((page as any).body ?? "");
  const open = /```html\s*\n/.exec(body);
  if (!open) return NextResponse.json({ error: "not found" }, { status: 404 });
  const rest = body.slice(open.index + open[0].length);
  const end = rest.lastIndexOf("\n```");
  if (end < 0) return NextResponse.json({ error: "not found" }, { status: 404 });
  const html = rest.slice(0, end);
  if (Buffer.byteLength(html, "utf8") > MAX_BYTES) return NextResponse.json({ error: "too large" }, { status: 404 });
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'",
      "Cache-Control": "no-store",
    },
  });
}
