// Shared by the browser (fast feedback) and /api/chat (authoritative).
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 10;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export const ALLOWED_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "heic",
  "pdf",
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "html", "htm", "log", "rtf",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx",
]);

function mb(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return mb(n);
}

export function validateChatFiles(
  files: { name: string; size: number }[],
  alreadyPending = 0,
  alreadyPendingBytes = 0
): { ok: number[]; rejected: { name: string; reason: string }[] } {
  const ok: number[] = [];
  const rejected: { name: string; reason: string }[] = [];
  let count = alreadyPending;
  let total = alreadyPendingBytes;
  files.forEach((f, i) => {
    const ext = (f.name.split(".").pop() ?? "").toLowerCase();
    if (!f.name.includes(".") || !ALLOWED_EXT.has(ext)) {
      rejected.push({ name: f.name, reason: `"${f.name}" isn't a supported file type (use PDF, image, Word/Excel/PowerPoint, text, CSV…)` });
    } else if (f.size > MAX_FILE_BYTES) {
      rejected.push({ name: f.name, reason: `"${f.name}" is ${mb(f.size)}; the limit is 25 MB per file` });
    } else if (count >= MAX_FILES) {
      rejected.push({ name: f.name, reason: `Only ${MAX_FILES} files per message` });
    } else if (total + f.size > MAX_TOTAL_BYTES) {
      rejected.push({ name: f.name, reason: `"${f.name}" would take this message over 50 MB in total` });
    } else {
      ok.push(i);
      count++;
      total += f.size;
    }
  });
  return { ok, rejected };
}
