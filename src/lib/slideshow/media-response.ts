import fs from "node:fs";
import { Readable } from "node:stream";

/** Serve a file with HTTP Range support, streaming from disk (never loads the file into memory). */
export function streamMedia(absPath: string, mime: string, rangeHeader: string | null, headers: Record<string, string> = {}): Response {
  let size: number;
  try { size = fs.statSync(absPath).size; } catch { return new Response("Not found", { status: 404 }); }
  const base: Record<string, string> = { ...headers, "Content-Type": mime, "Accept-Ranges": "bytes" };
  const send = (start: number, end: number, status: number, extra: Record<string, string>) => {
    const body = Readable.toWeb(fs.createReadStream(absPath, { start, end })) as unknown as ReadableStream;
    return new Response(body, { status, headers: { ...base, ...extra, "Content-Length": String(end - start + 1) } });
  };
  if (!rangeHeader) {
    if (size === 0) return new Response(null, { status: 200, headers: { ...base, "Content-Length": "0" } });
    return send(0, size - 1, 200, {});
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  const unsat = () => new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
  if (!m || (m[1] === "" && m[2] === "") || size === 0) return unsat();
  let start: number, end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return unsat();
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return unsat();
  return send(start, end, 206, { "Content-Range": `bytes ${start}-${end}/${size}` });
}
