import { NextRequest, NextResponse } from "next/server";
import { saveUploadedFile } from "@/lib/attachments";

// Images and files dropped into a page in the editor. Returns the URL the page embeds.
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "file is required" }, { status: 400 });
  const att = await saveUploadedFile(file);
  return NextResponse.json({ url: `/api/uploads/${att.path}`, ...att }, { status: 201 });
}
