"use client";
import { useEffect, useState } from "react";

// Read-only view of the "Cleanup candidates" file (id 361). GET only; no delete/archive/move actions.
const FILE_ID = 361;

function blockText(b: unknown): string {
  if (!b || typeof b !== "object") return "";
  const o = b as { content?: unknown; children?: unknown };
  let out = "";
  if (typeof o.content === "string") out += o.content;
  else if (Array.isArray(o.content)) {
    out += o.content.map((c) => (c && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("");
  }
  if (Array.isArray(o.children)) out += "\n" + o.children.map(blockText).join("\n");
  return out;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

export default function CleanupList() {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/files/${FILE_ID}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
      .then((d: { blocks?: unknown[] }) => {
        if (!alive) return;
        const lines = (d.blocks || []).flatMap((b) => blockText(b).split("\n")).filter((l) => l.trim().startsWith("|"));
        const parsed = lines.map(splitRow).filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c) || c === ""));
        setRows(parsed);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const [head, ...body] = rows || [];

  return (
    <div className="space-y-3" data-testid="cleanup-panel">
      <div className="text-sm rounded-lg border border-panel-border bg-wash-2 p-3" data-testid="cleanup-superseded">
        Superseded by Settings &gt; Weekly cleanup
      </div>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">Read-only list of files and code flagged as cleanup candidates.</p>
        <a href={`/files?id=${FILE_ID}`} className="text-sm text-accent underline">
          Open in Files
        </a>
      </div>
      {rows === null && !error && <div className="text-sm text-muted">Loading…</div>}
      {error && <div className="text-sm text-muted">No candidates listed.</div>}
      {rows !== null && rows.length === 0 && <div className="text-sm text-muted">No candidates listed.</div>}
      {head && (
        <div className="bg-panel border border-panel-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                {head.map((c, i) => (
                  <th key={i} className="p-3 font-medium">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-panel-border">
              {body.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className="p-3 align-top">{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
