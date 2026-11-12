"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Obsidian-style graph of the codebase. Display-only: reads /api/code-map. No packages:
// canvas + small hand-written force simulation. Pan/zoom (wheel, drag, touch pinch), drag nodes,
// hover/tap highlights connections and shows path, node size = connections, colour = folder.

type ApiNode = { id?: string; purpose?: string; lines?: number; imports?: string[]; importedBy?: string[] };
type GN = {
  i: number; id: string; label: string; group: string; gi: number; purpose: string; lines: number;
  x: number; y: number; vx: number; vy: number; fixed: boolean;
  out: number[]; inn: number[]; deg: number; r: number;
};
type View = { x: number; y: number; k: number };
type Pt = { x: number; y: number };
type Gesture =
  | { mode: "none" }
  | { mode: "pan"; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { mode: "node"; n: GN; sx: number; sy: number; moved: boolean }
  | { mode: "pinch"; d0: number; k0: number; wx: number; wy: number };
type Group = { group: string; count: number; color: string };
type State = {
  nodes: GN[]; edges: [number, number][]; colors: string[]; alpha: number; dirty: boolean; view: View;
  hover: number; sel: number; w: number; h: number; dpr: number; needFit: boolean; fitDone: boolean;
  userMoved: boolean; hidden: Set<string>; matches: Set<number> | null; gest: Gesture; ptrs: Map<number, Pt>;
};

const MAX_NODES = 1500;

function fit(s: State) {
  const vis = s.nodes.filter((n) => !s.hidden.has(n.group));
  if (!vis.length || !s.w || !s.h) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of vis) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
  const bw = Math.max(40, x1 - x0) + 80, bh = Math.max(40, y1 - y0) + 80;
  const k = Math.max(0.1, Math.min(2, s.w / bw, s.h / bh));
  s.view = { k, x: s.w / 2 - ((x0 + x1) / 2) * k, y: s.h / 2 - ((y0 + y1) / 2) * k };
  s.dirty = true;
}

function tick(s: State) {
  const ns = s.nodes, a = s.alpha;
  for (let i = 0; i < ns.length; i++) {
    const p = ns[i];
    for (let j = i + 1; j < ns.length; j++) {
      const q = ns[j];
      let dx = p.x - q.x, dy = p.y - q.y;
      let d2 = dx * dx + dy * dy;
      if (d2 > 90000) continue;
      if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx * dx + dy * dy + 0.01; }
      const d = Math.sqrt(d2);
      const f = (900 / (d2 + 40)) * a;
      p.vx += (dx / d) * f; p.vy += (dy / d) * f;
      q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
    }
  }
  for (const [si, ti] of s.edges) {
    const p = ns[si], q = ns[ti];
    const dx = q.x - p.x, dy = q.y - p.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - 55) * 0.03 * a;
    p.vx += (dx / d) * f; p.vy += (dy / d) * f;
    q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
  }
  // pull each folder group toward its own centroid so colours cluster
  const gs = s.colors.length;
  const sx = new Array<number>(gs).fill(0), sy = new Array<number>(gs).fill(0), sc = new Array<number>(gs).fill(0);
  for (const n of ns) { sx[n.gi] += n.x; sy[n.gi] += n.y; sc[n.gi]++; }
  for (const n of ns) {
    const c = sc[n.gi] || 1;
    n.vx += (sx[n.gi] / c - n.x) * 0.02 * a - n.x * 0.003 * a;
    n.vy += (sy[n.gi] / c - n.y) * 0.02 * a - n.y * 0.003 * a;
    const sp = Math.hypot(n.vx, n.vy);
    if (sp > 30) { n.vx = (n.vx / sp) * 30; n.vy = (n.vy / sp) * 30; }
    if (n.fixed) { n.vx = 0; n.vy = 0; } else { n.x += n.vx; n.y += n.vy; }
    n.vx *= 0.6; n.vy *= 0.6;
  }
}

function draw(s: State, c: HTMLCanvasElement) {
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const { nodes, edges, view: v } = s;
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
  ctx.clearRect(0, 0, s.w, s.h);
  c.dataset.view = `${Math.round(v.x)},${Math.round(v.y)},${v.k.toFixed(3)}`;
  const focus = s.hover >= 0 ? s.hover : s.sel;
  const fset = focus >= 0 && nodes[focus] ? new Set<number>([focus, ...nodes[focus].out, ...nodes[focus].inn]) : null;
  const vis = (n: GN) => !s.hidden.has(n.group);
  ctx.save();
  ctx.translate(v.x, v.y);
  ctx.scale(v.k, v.k);
  ctx.lineWidth = 1 / v.k;
  ctx.strokeStyle = fset ? "rgba(148,163,184,0.06)" : "rgba(148,163,184,0.28)";
  ctx.beginPath();
  for (const [a, b] of edges) {
    const p = nodes[a], q = nodes[b];
    if (!vis(p) || !vis(q)) continue;
    ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
  if (fset && nodes[focus]) {
    ctx.lineWidth = 1.8 / v.k;
    const f = nodes[focus];
    ctx.strokeStyle = "rgba(96,165,250,0.95)"; // imports (outgoing)
    ctx.beginPath();
    for (const t of f.out) { if (!vis(nodes[t])) continue; ctx.moveTo(f.x, f.y); ctx.lineTo(nodes[t].x, nodes[t].y); }
    ctx.stroke();
    ctx.strokeStyle = "rgba(251,191,36,0.95)"; // imported by (incoming)
    ctx.beginPath();
    for (const t of f.inn) { if (!vis(nodes[t])) continue; ctx.moveTo(nodes[t].x, nodes[t].y); ctx.lineTo(f.x, f.y); }
    ctx.stroke();
  }
  for (const n of nodes) {
    if (!vis(n)) continue;
    ctx.globalAlpha = fset && !fset.has(n.i) ? 0.12 : s.matches && !s.matches.has(n.i) ? 0.15 : 1;
    ctx.fillStyle = s.colors[n.gi];
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fill();
    if (n.i === s.sel || n.i === s.hover) {
      ctx.lineWidth = 2 / v.k; ctx.strokeStyle = "#fff"; ctx.stroke();
    } else if (s.matches && s.matches.has(n.i)) {
      ctx.lineWidth = 2 / v.k; ctx.strokeStyle = "#facc15"; ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // labels in screen space
  ctx.font = "11px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const label = (n: GN) => {
    const px = n.x * v.k + v.x, py = n.y * v.k + v.y;
    if (px < -50 || py < -20 || px > s.w + 50 || py > s.h + 20) return;
    const tx = px + n.r * v.k + 4;
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(10,10,10,0.85)"; ctx.strokeText(n.label, tx, py);
    ctx.fillStyle = "#e2e8f0"; ctx.fillText(n.label, tx, py);
  };
  if (fset) { if (fset.size <= 40) fset.forEach((i) => vis(nodes[i]) && label(nodes[i])); }
  else for (const n of nodes) { if (vis(n) && ((n.deg >= 15 && v.k >= 0.6) || v.k >= 3)) label(n); }

  // tooltip: file name + path for hovered (mouse) or selected (tap/click) node
  const tn = focus >= 0 ? nodes[focus] : null;
  if (tn && vis(tn)) {
    const l1 = tn.id, l2 = `${tn.out.length} imports · ${tn.inn.length} imported by`;
    ctx.font = "600 11px system-ui, sans-serif";
    const w1 = ctx.measureText(l1).width;
    ctx.font = "11px system-ui, sans-serif";
    const bw = Math.min(s.w - 8, Math.max(w1, ctx.measureText(l2).width) + 16), bh = 38;
    let bx = tn.x * v.k + v.x + tn.r * v.k + 10, by = tn.y * v.k + v.y - bh / 2;
    bx = Math.max(4, Math.min(s.w - bw - 4, bx)); by = Math.max(4, Math.min(s.h - bh - 4, by));
    ctx.fillStyle = "rgba(15,23,42,0.95)"; ctx.strokeStyle = s.colors[tn.gi]; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#f8fafc"; ctx.font = "600 11px system-ui, sans-serif"; ctx.fillText(l1, bx + 8, by + 12, bw - 16);
    ctx.fillStyle = "#94a3b8"; ctx.font = "11px system-ui, sans-serif"; ctx.fillText(l2, bx + 8, by + 27, bw - 16);
  }
}

function hitTest(s: State, p: Pt, ptype: string): GN | null {
  const v = s.view;
  const wx = (p.x - v.x) / v.k, wy = (p.y - v.y) / v.k;
  const tol = (ptype === "touch" ? 14 : 4) / v.k;
  let best: GN | null = null, bd = Infinity;
  for (const n of s.nodes) {
    if (s.hidden.has(n.group)) continue;
    const d = Math.hypot(n.x - wx, n.y - wy) - n.r;
    if (d <= tol && d < bd) { bd = d; best = n; }
  }
  return best;
}

export default function CodeGraph() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const g = useRef<State>({
    nodes: [], edges: [], colors: [], alpha: 0, dirty: true, view: { x: 0, y: 0, k: 1 }, hover: -1, sel: -1,
    w: 0, h: 0, dpr: 1, needFit: false, fitDone: false, userMoved: false, hidden: new Set(), matches: null,
    gest: { mode: "none" }, ptrs: new Map(),
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState({ nodes: 0, edges: 0 });
  const [groups, setGroups] = useState<Group[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selIdx, setSelIdx] = useState(-1);
  const [query, setQuery] = useState("");

  const select = useCallback((i: number) => {
    g.current.sel = i; g.current.dirty = true; setSelIdx(i);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/code-map");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const raw: ApiNode[] = (Array.isArray(data.nodes) ? data.nodes : []).slice(0, MAX_NODES);
      const idx = new Map<string, number>();
      raw.forEach((n, i) => idx.set(String(n.id || ""), i));
      const counts = new Map<string, number>();
      const base = raw.map((n) => {
        const id = String(n.id || "");
        const group = id.split("/").slice(0, -1).slice(0, 3).join("/") || "(root)";
        counts.set(group, (counts.get(group) || 0) + 1);
        return { id, group, n };
      });
      const order = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const gIndex = new Map(order.map(([gr], i) => [gr, i]));
      const colors = order.map((_, i) => `hsl(${Math.round((i * 137.5) % 360)} 70% 62%)`);
      const nodes: GN[] = base.map(({ id, group, n }, i) => {
        const a = i * 2.39996, rr = 14 * Math.sqrt(i + 1);
        return {
          i, id, label: id.split("/").pop() || id, group, gi: gIndex.get(group) || 0, purpose: n.purpose || "", lines: n.lines || 0,
          x: Math.cos(a) * rr, y: Math.sin(a) * rr, vx: 0, vy: 0, fixed: false, out: [], inn: [], deg: 0, r: 4,
        };
      });
      const seen = new Set<string>();
      const edges: [number, number][] = [];
      const add = (f: unknown, t: unknown) => {
        const a = idx.get(String(f)), b = idx.get(String(t));
        if (a === undefined || b === undefined || a === b) return;
        const k = a + ">" + b;
        if (seen.has(k)) return;
        seen.add(k); edges.push([a, b]); nodes[a].out.push(b); nodes[b].inn.push(a);
      };
      raw.forEach((n) => (n.imports || []).forEach((t) => add(n.id, t)));
      for (const e of (Array.isArray(data.edges) ? data.edges : []) as { s?: string; t?: string }[]) add(e?.s, e?.t);
      for (const n of nodes) { n.deg = n.out.length + n.inn.length; n.r = 3 + Math.min(16, Math.sqrt(n.deg) * 2.2); }
      const s = g.current;
      s.nodes = nodes; s.edges = edges; s.colors = colors; s.sel = -1; s.hover = -1; s.alpha = 1;
      s.needFit = true; s.fitDone = false; s.userMoved = false; s.matches = null;
      for (let k = 0; k < 60 && nodes.length; k++) { tick(s); s.alpha *= 0.985; }
      s.dirty = true;
      setSelIdx(-1);
      setInfo({ nodes: nodes.length, edges: edges.length });
      setGroups(order.map(([group, count], i) => ({ group, count, color: colors[i] })));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // render + simulation loop
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const s = g.current, c = canvasRef.current;
      if (c) {
        if (s.needFit && s.w > 0 && s.nodes.length) { fit(s); s.needFit = false; }
        if (s.alpha > 0.004 && s.nodes.length) {
          tick(s); s.alpha *= 0.985; s.dirty = true;
          if (s.alpha < 0.05 && !s.userMoved && !s.fitDone) { s.fitDone = true; fit(s); }
        }
        if (s.dirty) { s.dirty = false; draw(s, c); }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // size to container + wheel zoom
  useEffect(() => {
    const wrap = wrapRef.current, c = canvasRef.current;
    if (!wrap || !c) return;
    const resize = () => {
      const s = g.current, r = wrap.getBoundingClientRect();
      s.dpr = Math.min(window.devicePixelRatio || 1, 2);
      s.w = Math.max(1, Math.floor(r.width)); s.h = Math.max(1, Math.floor(r.height));
      c.width = Math.floor(s.w * s.dpr); c.height = Math.floor(s.h * s.dpr);
      s.dirty = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = g.current, v = s.view, r = c.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const k = Math.max(0.1, Math.min(8, v.k * Math.exp(-e.deltaY * 0.0015)));
      const wx = (px - v.x) / v.k, wy = (py - v.y) / v.k;
      s.view = { k, x: px - wx * k, y: py - wy * k };
      s.userMoved = true; s.dirty = true;
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => { ro.disconnect(); c.removeEventListener("wheel", onWheel); };
  }, []);

  useEffect(() => { g.current.hidden = hidden; g.current.dirty = true; }, [hidden]);
  useEffect(() => {
    const q = query.trim().toLowerCase();
    g.current.matches = q ? new Set(g.current.nodes.filter((n) => n.id.toLowerCase().includes(q) || n.purpose.toLowerCase().includes(q)).map((n) => n.i)) : null;
    g.current.dirty = true;
  }, [query, info]);

  const centerOn = (i: number) => {
    const s = g.current, n = s.nodes[i];
    if (!n) return;
    s.view = { ...s.view, x: s.w / 2 - n.x * s.view.k, y: s.h / 2 - n.y * s.view.k };
    s.userMoved = true; s.dirty = true;
  };
  const jump = (i: number) => { select(i); centerOn(i); };

  const loc = (c: HTMLCanvasElement, e: { clientX: number; clientY: number }): Pt => {
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = g.current, c = e.currentTarget;
    c.setPointerCapture?.(e.pointerId);
    const p = loc(c, e);
    s.ptrs.set(e.pointerId, p); s.userMoved = true;
    if (s.ptrs.size === 2) {
      if (s.gest.mode === "node") s.gest.n.fixed = false;
      const [a, b] = [...s.ptrs.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      s.gest = { mode: "pinch", d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), k0: s.view.k, wx: (mx - s.view.x) / s.view.k, wy: (my - s.view.y) / s.view.k };
      return;
    }
    if (s.ptrs.size > 2) return;
    const hit = hitTest(s, p, e.pointerType);
    s.gest = hit ? { mode: "node", n: hit, sx: p.x, sy: p.y, moved: false } : { mode: "pan", sx: p.x, sy: p.y, vx: s.view.x, vy: s.view.y, moved: false };
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = g.current, c = e.currentTarget, p = loc(c, e);
    if (s.ptrs.has(e.pointerId)) s.ptrs.set(e.pointerId, p);
    const gs = s.gest;
    if (gs.mode === "pinch") {
      if (s.ptrs.size < 2) return;
      const [a, b] = [...s.ptrs.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const k = Math.max(0.1, Math.min(8, gs.k0 * (Math.hypot(a.x - b.x, a.y - b.y) / gs.d0)));
      s.view = { k, x: mx - gs.wx * k, y: my - gs.wy * k };
      s.dirty = true;
    } else if (gs.mode === "pan") {
      if (!gs.moved && Math.hypot(p.x - gs.sx, p.y - gs.sy) < 4) return;
      gs.moved = true;
      s.view = { ...s.view, x: gs.vx + (p.x - gs.sx), y: gs.vy + (p.y - gs.sy) };
      s.dirty = true;
    } else if (gs.mode === "node") {
      if (!gs.moved && Math.hypot(p.x - gs.sx, p.y - gs.sy) < 4) return;
      gs.moved = true;
      gs.n.x = (p.x - s.view.x) / s.view.k; gs.n.y = (p.y - s.view.y) / s.view.k; gs.n.fixed = true;
      s.alpha = Math.max(s.alpha, 0.3); s.dirty = true;
    } else if (e.pointerType !== "touch") {
      const h = hitTest(s, p, e.pointerType);
      const hi = h ? h.i : -1;
      if (hi !== s.hover) { s.hover = hi; s.dirty = true; c.style.cursor = hi >= 0 ? "pointer" : "grab"; }
    }
  };

  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = g.current;
    s.ptrs.delete(e.pointerId);
    const gs = s.gest;
    if (gs.mode === "pinch") {
      if (s.ptrs.size === 1) {
        const [r] = [...s.ptrs.values()];
        s.gest = { mode: "pan", sx: r.x, sy: r.y, vx: s.view.x, vy: s.view.y, moved: true };
      } else s.gest = { mode: "none" };
      return;
    }
    s.gest = { mode: "none" };
    if (gs.mode === "node") {
      gs.n.fixed = false;
      if (!gs.moved) select(gs.n.i);
    } else if (gs.mode === "pan" && !gs.moved) select(-1);
  };

  const onLeave = () => { const s = g.current; if (s.hover !== -1 && s.gest.mode === "none") { s.hover = -1; s.dirty = true; } };

  const toggleGroup = (gr: string) => setHidden((h) => { const n = new Set(h); if (n.has(gr)) n.delete(gr); else n.add(gr); return n; });
  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    const s = g.current;
    if (!s.matches || !s.matches.size) return;
    const first = s.nodes.find((n) => s.matches!.has(n.i) && !s.hidden.has(n.group));
    if (first) jump(first.i);
  };

  const sel = selIdx >= 0 ? g.current.nodes[selIdx] : null;
  const nodesRef = g.current.nodes;

  return (
    <div className="flex flex-col gap-2 w-full" data-testid="code-graph-root" data-nodes={info.nodes} data-edges={info.edges}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input
          data-testid="code-graph-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Search path or purpose… (Enter to jump)"
          className="px-2 py-1 rounded border border-neutral-700 bg-transparent min-w-[200px] flex-1 max-w-sm"
        />
        <button type="button" onClick={() => void load()} className="px-2 py-1 rounded border border-neutral-700">Refresh</button>
        <button type="button" onClick={() => { g.current.userMoved = false; fit(g.current); }} className="px-2 py-1 rounded border border-neutral-700">Reset view</button>
        <span className="opacity-60" data-testid="code-graph-stats">{info.nodes} files · {info.edges} imports</span>
      </div>
      <div className="flex flex-wrap gap-1 text-[11px]">
        {groups.slice(0, 24).map((gr) => (
          <button
            key={gr.group}
            type="button"
            onClick={() => toggleGroup(gr.group)}
            title={`${gr.count} files — click to show/hide`}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-neutral-700"
            style={{ opacity: hidden.has(gr.group) ? 0.35 : 1 }}
          >
            <span style={{ background: gr.color, width: 8, height: 8, borderRadius: 4, display: "inline-block" }} />
            {gr.group} <span className="opacity-50">{gr.count}</span>
          </button>
        ))}
      </div>
      {error && <div className="text-xs text-red-400">Could not load code graph: {error}</div>}
      {loading && !info.nodes && <div className="text-xs opacity-60">Loading…</div>}
      <div ref={wrapRef} className="relative rounded border border-neutral-800 overflow-hidden w-full" style={{ height: "min(70vh, 640px)", minHeight: 340 }}>
        <canvas
          ref={canvasRef}
          data-testid="code-graph-canvas"
          className="block"
          style={{ width: "100%", height: "100%", touchAction: "none", cursor: "grab" }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={onLeave}
        />
      </div>
      <div className="text-[11px] opacity-60">
        Drag to pan · scroll or pinch to zoom · drag a dot to move it · hover/tap a dot to highlight its links (<span style={{ color: "#60a5fa" }}>blue = imports</span>, <span style={{ color: "#fbbf24" }}>amber = imported by</span>) · bigger dot = more connections
      </div>
      {sel && (
        <div data-testid="code-graph-detail" className="text-xs rounded border border-neutral-800 p-2">
          <div className="font-mono break-all font-semibold" data-testid="code-graph-detail-path">{sel.id}</div>
          <div className="mt-1"><span style={{ color: g.current.colors[sel.gi] }}>●</span> {sel.group} · {sel.lines} lines · {sel.deg} connections</div>
          {sel.purpose && <div className="mt-1 opacity-80">{sel.purpose}</div>}
          <div className="grid sm:grid-cols-2 gap-3 mt-2">
            <div>
              <div className="font-semibold">Imports ({sel.out.length})</div>
              <ul className="max-h-40 overflow-auto">
                {sel.out.slice(0, 60).map((i) => (<li key={i}><button type="button" className="text-left underline break-all" onClick={() => jump(i)}>{nodesRef[i].id}</button></li>))}
              </ul>
            </div>
            <div>
              <div className="font-semibold">Imported by ({sel.inn.length})</div>
              <ul className="max-h-40 overflow-auto">
                {sel.inn.slice(0, 60).map((i) => (<li key={i}><button type="button" className="text-left underline break-all" onClick={() => jump(i)}>{nodesRef[i].id}</button></li>))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
