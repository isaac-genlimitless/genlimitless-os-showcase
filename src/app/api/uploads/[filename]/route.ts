import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/data-dir";

const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".txt": "text/plain; charset=utf-8",
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  const safe = path.basename(filename); // prevent path traversal
  const filePath = path.join(UPLOAD_DIR, safe);

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const buffer = fs.readFileSync(filePath);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": TYPES[path.extname(safe).toLowerCase()] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      // Uploads can come from outsiders (email/chat attachments): never let one run as a page on the OS origin.
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
      "Content-Disposition": TYPES[path.extname(safe).toLowerCase()] ? "inline" : "attachment",
    },
  });
}
