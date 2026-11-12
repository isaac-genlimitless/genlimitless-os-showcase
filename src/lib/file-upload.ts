import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createPage, filesDir, type Page } from "./pages";
import { scheduleOrganize } from "./organize";

// Uploaded files become items in the Files tree. Text-like files also get their text copied into
// the item's body so search, auto-filing and the agents can read them.

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript))/;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|html?|log)$/i;
const MAX_TEXT = 200_000;

export async function saveFileToWorkspace(file: File, parentId: number | null): Promise<Page> {
  const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(-120);
  const stored = `${crypto.randomUUID()}-${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(path.join(filesDir(), stored), buffer);
  const mime = file.type || "application/octet-stream";
  const isText = TEXT_TYPES.test(mime) || TEXT_EXT.test(file.name);
  const text = isText ? buffer.toString("utf8").slice(0, MAX_TEXT) : "";
  const page = await createPage({
    title: file.name,
    kind: "file",
    parent_id: parentId,
    file_path: stored,
    mime_type: mime,
    file_size: buffer.length,
    // Markdown files become readable pages' text; other text is kept verbatim in a code block.
    body: text ? (/\.(md|markdown)$/i.test(file.name) ? text : "```\n" + text + "\n```") : "",
    created_by: "owner",
  });
  scheduleOrganize(page.id, 2_000);
  return page;
}
