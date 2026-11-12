import { NextResponse } from "next/server";
import db from "@/lib/db";
import { listTree } from "@/lib/pages";

// Read-only graph of the Files workspace: nodes (no bodies), folder edges, detected page links.

export const dynamic = "force-dynamic";

const MAX_EDGES = 5000;

export async function GET() {
  const tree = listTree();
  const byId = new Map(tree.map((t) => [t.id, t]));

  const topOf = (id: number): number => {
    const seen = new Set<number>();
    let cur = id;
    while (!seen.has(cur)) {
      seen.add(cur);
      const p = byId.get(cur)?.parent_id;
      if (p == null || !byId.has(p)) break;
      cur = p;
    }
    return cur;
  };

  const nodes = tree.map((t) => ({
    id: t.id,
    title: t.title,
    kind: t.kind,
    parent_id: t.parent_id,
    updated_at: t.updated_at,
    top: topOf(t.id),
  }));

  const edges: { source: number; target: number; type: "folder" | "link" }[] = [];
  for (const t of tree) {
    if (t.parent_id != null && byId.has(t.parent_id) && edges.length < MAX_EDGES) {
      edges.push({ source: t.parent_id, target: t.id, type: "folder" });
    }
  }

  const byTitle = new Map<string, number>();
  for (const t of tree) {
    if (t.kind === "folder") continue;
    const k = (t.title || "").trim().toLowerCase();
    if (k && !byTitle.has(k)) byTitle.set(k, t.id);
  }

  const rows = db.prepare(`SELECT id, body FROM docs WHERE status='active' AND kind='page'`).all() as {
    id: number;
    body: string | null;
  }[];
  const seenLinks = new Set<string>();
  const add = (source: number, target: number) => {
    if (source === target || !byId.has(target) || edges.length >= MAX_EDGES) return;
    const key = `${source}>${target}`;
    if (seenLinks.has(key)) return;
    seenLinks.add(key);
    edges.push({ source, target, type: "link" });
  };
  for (const r of rows) {
    if (!r.body || !byId.has(r.id)) continue;
    for (const m of r.body.matchAll(/files?id=(\d+)/g)) add(r.id, Number(m[1]));
    for (const m of r.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = byTitle.get(m[1].trim().toLowerCase());
      if (target != null) add(r.id, target);
    }
    if (edges.length >= MAX_EDGES) break;
  }

  return NextResponse.json({ nodes, edges, generated_at: new Date().toISOString() });
}
