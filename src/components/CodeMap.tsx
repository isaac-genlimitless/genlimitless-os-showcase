"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Read-only force graph of the codebase, fed by /api/code-map. No packages: own rAF simulation + SVG.

const ROLES = ["api", "ui-page", "ui-component", "agents", "tools", "db", "integrations", "core", "tests", "other"] as const;
const COLORS: Record<string, string> = {
  api: "#60a5fa", "ui-page": "#f472b6", "ui-component": "#c084fc", agents: "#fbbf24", tools: "#34d399",
  db: "#f87171", integrations: "#22d3ee", core: "#a3e635", tests: "#94a3b8", other: "#cbd5e1",
};

type RawNode = { id?: string; path?: string; role?: string; purpose?: string; lines?: number; lineCount?: number; external?: string[]; externals?: string[]; packages?: string[] };
type RawEdge = { from?: string; to?: string; source?: string; target?: string; s?: string; t?: string } | [string, string];
type N = { path: string; role: string; purpose: string; lines: number; external: string[]; folder: string; x: number; y: number; vx: number; vy: number; fixed: boolean; imports: string[]; importedBy: string[]; r: number };

const roleOf = (r?: string) => ((ROLES as readonly string[]).includes(r || "") ? (r as string) : "other");

// Layout constants. Radius is capped (4..7) so a hub file can't swallow its neighbours; PAD is the clear gap kept between dots.
const R_MIN = 4, R_MAX = 7, PAD = 3;
const Z_MIN = 0.1, Z_MAX = 8, LABEL_ZOOM = 2, LABEL_BUDGET = 60;
const W = 1000, H = 700;
const clampK = (k: number) => Math.max(Z_MIN, Math.min(Z_MAX, k));

const gridKey = (cx: number, cy: number) => (cx + 20000) * 40000 + (cy + 20000);

// Grid-based positional collision resolution: pushes overlapping dots apart until every pair is >= r1 + r2 + gap.
// Fixed (being-dragged) dots never move. Returns how many pairs were still too close at the start of the last pass.
function resolveCollisions(ns: N[], iters: number, gap: number = PAD): number {
  const cell = R_MAX * 2 + gap + 2;
  let tight = 0;
  for (let it = 0; it < iters; it++) {
    const grid = new Map<number, number[]>();
    for (let i = 0; i < ns.length; i++) {
      const p = ns[i];
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { p.x = W / 2 + (i % 17); p.y = H / 2 + (i % 13); }
      const key = gridKey(Math.floor(p.x / cell), Math.floor(p.y / cell));
      const b = grid.get(key);
      if (b) b.push(i); else grid.set(key, [i]);
    }
    tight = 0;
    for (let i = 0; i < ns.length; i++) {
      const p = ns[i];
      const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const b = grid.get(gridKey(gx, gy));
          if (!b) continue;
          for (const j of b) {
            if (j <= i) continue;
            const q = ns[j];
            const min = p.r + q.r + gap;
            let dx = p.x - q.x, dy = p.y - q.y;
            let d = Math.sqrt(dx * dx + dy * dy);
            if (d >= min) continue;
            tight++;
            if (d < 0.001) { const a = (i * 2.399963) % (Math.PI * 2); dx = Math.cos(a); dy = Math.sin(a); d = 1; }
            if (p.fixed && q.fixed) continue;
            const push = (min - d) * 0.55; // slight over-correction so it converges in few passes
            const ux = dx / d, uy = dy / d;
            if (p.fixed) { q.x -= ux * push * 2; q.y -= uy * push * 2; }
            else if (q.fixed) { p.x += ux * push * 2; p.y += uy * push * 2; }
            else { p.x += ux * push; p.y += uy * push; q.x -= ux * push; q.y -= uy * push; }
          }
        }
      }
    }
    if (tight === 0) break;
  }
  return tight;
}

// Pairs whose drawn dots actually touch (distance < r1 + r2).
function countOverlaps(ns: N[]): number {
  const cell = R_MAX * 2 + 2;
  const grid = new Map<number, number[]>();
  ns.forEach((p, i) => {
    const key = gridKey(Math.floor(p.x / cell), Math.floor(p.y / cell));
    const b = grid.get(key);
    if (b) b.push(i); else grid.set(key, [i]);
  });
  let n = 0;
  for (let i = 0; i < ns.length; i++) {
    const p = ns[i];
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const b = grid.get(gridKey(gx, gy));
        if (!b) continue;
        for (const j of b) {
          if (j <= i) continue;
          const q = ns[j];
          if (Math.hypot(p.x - q.x, p.y - q.y) < p.r + q.r) n++;
        }
      }
    }
  }
  return n;
}

function fitView(ns: N[]) {
  if (!ns.length) return { x: 0, y: 0, k: 1 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of ns) { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); }
  const bw = Math.max(x1 - x0, 1) + 60, bh = Math.max(y1 - y0, 1) + 60;
  const k = clampK(Math.min(W / bw, H / bh, 3));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { k, x: W / 2 - cx * k, y: H / 2 - cy * k };
}

export default function CodeMap() {
  const [nodes, setNodes] = useState<N[]>([]);
  const [edges, setEdges] = useState<[number, number][]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [stats, setStats] = useState({ settled: false, overlaps: -1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const nodesRef = useRef<N[]>([]);
  const edgesRef = useRef<[number, number][]>([]);
  const alpha = useRef(1);
  const raf = useRef(0);
  const settledRef = useRef(false);
  const fitPending = useRef(true);
  const viewRef = useRef(view);
  viewRef.current = view;
  const applyView = (v: { x: number; y: number; k: number }) => { viewRef.current = v; setView(v); };

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/code-map");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const raw: RawNode[] = (data.nodes || data.files || []).slice(0, 800);
      const idx = new Map<string, number>();
      const ns: N[] = raw.map((n, i) => {
        const path = String(n.path || n.id || "");
        idx.set(path, i);
        // phyllotaxis spiral: ~19px spacing (> 2*R_MAX+PAD), ordered by file list so folders start near each other
        const a = i * 2.399963, rad = 11 * Math.sqrt(i + 1);
        const folder = path.split("/").slice(0, -1).join("/");
        return {
          path, role: roleOf(n.role), purpose: n.purpose || "", lines: n.lines ?? n.lineCount ?? 0,
          external: n.external || n.externals || n.packages || [], folder,
          x: W / 2 + Math.cos(a) * rad, y: H / 2 + Math.sin(a) * rad, vx: 0, vy: 0, fixed: false,
          imports: [], importedBy: [], r: R_MIN,
        };
      });
      const es: [number, number][] = [];
      for (const e of (data.edges || data.links || []) as RawEdge[]) {
        const f = Array.isArray(e) ? e[0] : e.from ?? e.source ?? e.s;
        const t = Array.isArray(e) ? e[1] : e.to ?? e.target ?? e.t;
        const a = idx.get(String(f)), b = idx.get(String(t));
        if (a === undefined || b === undefined || a === b) continue;
        es.push([a, b]);
        ns[a].imports.push(ns[b].path);
        ns[b].importedBy.push(ns[a].path);
      }
      // capped size: importance only adds up to 3px so hubs never swallow neighbours
      for (const n of ns) n.r = R_MIN + Math.min(R_MAX - R_MIN, Math.sqrt(n.importedBy.length) * 0.7);
      nodesRef.current = ns;
      edgesRef.current = es;
      setNodes(ns);
      setEdges(es);
      alpha.current = 1;
      settledRef.current = false;
      fitPending.current = true;
      setStats({ settled: false, overlaps: -1 });
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // force simulation
  useEffect(() => {
    if (!nodes.length) return;
    const step = () => {
      const ns = nodesRef.current, es = edgesRef.current;
      if (alpha.current >= 0.01) {
        const a = alpha.current;
        for (let i = 0; i < ns.length; i++) {
          const p = ns[i];
          for (let j = i + 1; j < ns.length; j++) {
            const q = ns[j];
            let dx = p.x - q.x, dy = p.y - q.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > 176400) continue;
            if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
            const d = Math.sqrt(d2) || 1;
            const f = (2400 / (d2 + 50)) * a;
            p.vx += (dx / d) * f; p.vy += (dy / d) * f;
            q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
            if (p.folder === q.folder && d > 60) {
              const g = 0.002 * a;
              p.vx -= dx * g; p.vy -= dy * g; q.vx += dx * g; q.vy += dy * g;
            }
          }
        }
        for (const [s, t] of es) {
          const p = ns[s], q = ns[t];
          const dx = q.x - p.x, dy = q.y - p.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = (d - 85) * 0.012 * a;
          p.vx += (dx / d) * f; p.vy += (dy / d) * f;
          q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
        }
        for (const p of ns) {
          p.vx += (W / 2 - p.x) * 0.0015 * a;
          p.vy += (H / 2 - p.y) * 0.0015 * a;
          p.vx = Math.max(-30, Math.min(30, p.vx));
          p.vy = Math.max(-30, Math.min(30, p.vy));
          if (!p.fixed) { p.x += p.vx; p.y += p.vy; }
          p.vx *= 0.6; p.vy *= 0.6;
        }
        resolveCollisions(ns, 2);
        alpha.current *= 0.985;
        settledRef.current = false;
        setStats((s) => (s.settled ? { settled: false, overlaps: s.overlaps } : s));
        setTick((t) => t + 1);
      } else if (!settledRef.current) {
        // cooled: hard-resolve any remaining contact, record the result, fit the view once per load
        resolveCollisions(ns, 300);
        const overlaps = countOverlaps(ns);
        settledRef.current = true;
        if (fitPending.current) { fitPending.current = false; applyView(fitView(ns)); }
        setStats({ settled: true, overlaps });
        setTick((t) => t + 1);
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [nodes]);

  const toWorld = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    const sx = ((cx - r.left) / r.width) * W, sy = ((cy - r.top) / r.height) * H;
    return { x: (sx - v.x) / v.k, y: (sy - v.y) / v.k, sx, sy };
  };

  const zoomAt = (sx: number, sy: number, factor: number) => {
    const v = viewRef.current;
    const k = clampK(v.k * factor);
    const wx = (sx - v.x) / v.k, wy = (sy - v.y) / v.k;
    applyView({ k, x: sx - wx * k, y: sy - wy * k });
  };

  // wheel zoom (non-passive so we can preventDefault)
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const sx = ((e.clientX - r.left) / r.width) * W, sy = ((e.clientY - r.top) / r.height) * H;
      zoomAt(sx, sy, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, loading]);

  const drag = useRef<{ kind: "bg" | "node"; n?: N; sx: number; sy: number; moved: boolean; vx: number; vy: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);

  const pinchState = () => {
    const pts = [...pointers.current.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const w = toWorld((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
    return { dist, cx: w.sx, cy: w.sy };
  };

  // returns true when a second finger is down (pinch mode): any single-finger drag is cancelled cleanly
  const track = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2) {
      if (drag.current?.kind === "node" && drag.current.n) drag.current.n.fixed = false;
      drag.current = null;
      pinch.current = pinchState();
      return true;
    }
    pinch.current = null;
    return false;
  };
  const capture = (e: React.PointerEvent) => { try { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); } catch { /* synthetic/inactive pointer */ } };

  const onBgDown = (e: React.PointerEvent) => {
    if (track(e)) return;
    drag.current = { kind: "bg", sx: e.clientX, sy: e.clientY, moved: false, vx: viewRef.current.x, vy: viewRef.current.y };
    capture(e);
  };
  const onNodeDown = (e: React.PointerEvent, n: N) => {
    e.stopPropagation();
    if (track(e)) return;
    drag.current = { kind: "node", n, sx: e.clientX, sy: e.clientY, moved: false, vx: 0, vy: 0 };
    capture(e);
  };
  const onMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2 && pinch.current) {
      const prev = pinch.current;
      const cur = pinchState();
      if (prev.dist > 1) {
        const v = viewRef.current;
        const k = clampK(v.k * (cur.dist / prev.dist));
        const wx = (prev.cx - v.x) / v.k, wy = (prev.cy - v.y) / v.k;
        applyView({ k, x: cur.cx - wx * k, y: cur.cy - wy * k });
      }
      pinch.current = cur;
      return;
    }
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
    d.moved = true;
    if (d.kind === "bg") {
      const r = svgRef.current!.getBoundingClientRect();
      applyView({ ...viewRef.current, x: d.vx + ((e.clientX - d.sx) / r.width) * W, y: d.vy + ((e.clientY - d.sy) / r.height) * H });
    } else if (d.n) {
      const w = toWorld(e.clientX, e.clientY);
      d.n.x = w.x; d.n.y = w.y; d.n.fixed = true;
      alpha.current = Math.max(alpha.current, 0.3);
      setTick((t) => t + 1);
    }
  };
  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    pinch.current = null;
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "node" && d.n) {
      d.n.fixed = false;
      if (!d.moved) setSelected(d.n.path);
    } else if (!d.moved) setSelected(null);
  };

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return null;
    return new Set(nodes.filter((n) => n.path.toLowerCase().includes(q) || n.purpose.toLowerCase().includes(q)).map((n) => n.path));
  }, [q, nodes]);

  const byPath = useMemo(() => new Map(nodes.map((n) => [n.path, n])), [nodes]);
  const sel = selected ? byPath.get(selected) || null : null;
  const neighbours = useMemo(() => (sel ? new Set([sel.path, ...sel.imports, ...sel.importedBy]) : null), [sel]);

  const jump = (p: string) => {
    const n = byPath.get(p);
    if (!n) return;
    setSelected(p);
    const v = viewRef.current;
    applyView({ ...v, x: W / 2 - n.x * v.k, y: H / 2 - n.y * v.k });
  };

  const toggleRole = (r: string) => setHidden((h) => { const s = new Set(h); if (s.has(r)) s.delete(r); else s.add(r); return s; });

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && matches && matches.size) {
      const first = nodes.find((n) => matches.has(n.path) && !hidden.has(n.role));
      if (first) jump(first.path);
    }
  };

  const nodeOpacity = (n: N) => {
    if (matches && !matches.has(n.path)) return 0.12;
    if (neighbours && !neighbours.has(n.path)) return 0.15;
    return 1;
  };

  // label culling: viewport window in world coordinates
  const k = view.k;
  const lx0 = -view.x / k - 20, lx1 = (W - view.x) / k + 20, ly0 = -view.y / k - 20, ly1 = (H - view.y) / k + 20;
  let labelsLeft = LABEL_BUDGET;

  const btnCls = "px-2 py-1 rounded border border-neutral-700 min-w-[32px]";
  const roleByPath = new Map<string, string>();
  for (const n of nodes) roleByPath.set(n.path, n.role);
  const hiddenLinksOf = (n: N) => {
    if (!hidden.size) return 0;
    let c = 0;
    for (const p of n.imports) if (hidden.has(roleByPath.get(p) || "")) c++;
    for (const p of n.importedBy) if (hidden.has(roleByPath.get(p) || "")) c++;
    return c;
  };
  const isolated = nodes.filter((n) => n.imports.length === 0 && n.importedBy.length === 0).length;

  return (
    <div className="flex flex-col gap-2 w-full" data-testid="code-map-root">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input
          data-testid="code-map-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Search path or purpose…"
          className="px-2 py-1 rounded border border-neutral-700 bg-transparent min-w-[200px] flex-1 sm:flex-none"
        />
        <button type="button" onClick={() => void load()} className={btnCls}>Refresh</button>
        <button type="button" data-testid="code-map-show-all" onClick={() => setHidden(new Set())} className={btnCls}>Show all</button>
        <button type="button" data-testid="code-map-zoom-in" aria-label="Zoom in" onClick={() => zoomAt(W / 2, H / 2, 1.4)} className={btnCls}>+</button>
        <button type="button" data-testid="code-map-zoom-out" aria-label="Zoom out" onClick={() => zoomAt(W / 2, H / 2, 1 / 1.4)} className={btnCls}>−</button>
        <button type="button" data-testid="code-map-fit" onClick={() => applyView(fitView(nodesRef.current))} className={btnCls}>Fit</button>
        <span className="opacity-60">{nodes.length} files · {edges.length} imports{matches ? ` · ${matches.size} match` : ""}
          <span data-testid="code-map-isolated">{` · ${isolated} unreferenced`}</span>
          {hidden.size > 0 ? ` · ${hidden.size} roles hidden` : ""}</span>
        {ROLES.map((r) => (
          <button
            key={r}
            type="button"
            data-testid={`code-map-legend-${r}`}
            onClick={() => toggleRole(r)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-neutral-700"
            style={{ opacity: hidden.has(r) ? 0.35 : 1 }}
          >
            <span style={{ background: COLORS[r], width: 8, height: 8, borderRadius: 4, display: "inline-block" }} />
            {r}
          </button>
        ))}
      </div>
      {error && <div className="text-xs text-red-400">Could not load code map: {error}</div>}
      {loading && !nodes.length && <div className="text-xs opacity-60">Loading…</div>}
      <div className="flex flex-col md:flex-row gap-2 items-stretch md:items-start">
        <svg
          ref={svgRef}
          data-testid="code-map"
          data-settled={stats.settled ? "true" : "false"}
          data-overlaps={stats.overlaps}
          data-node-count={nodes.length}
          viewBox={`0 0 ${W} ${H}`}
          className="flex-1 min-w-0 rounded border border-neutral-800"
          style={{ height: "clamp(320px, 65vh, 640px)", touchAction: "none", cursor: "grab" }}
          onPointerDown={onBgDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <defs>
            <marker id="cm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#64748b" />
            </marker>
          </defs>
          <g data-testid="code-map-group" transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {edges.map(([s, t], i) => {
              const a = nodes[s], b = nodes[t];
              if (hidden.has(a.role) || hidden.has(b.role)) return null;
              const hi = sel && (a.path === sel.path || b.path === sel.path);
              const dim = sel && !hi;
              return (
                <line
                  key={i}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={hi ? "#e2e8f0" : "#64748b"}
                  strokeWidth={hi ? 1.2 : 0.5}
                  strokeOpacity={dim ? 0.05 : hi ? 0.9 : 0.25}
                  markerEnd="url(#cm-arrow)"
                />
              );
            })}
            {nodes.map((n) => {
              if (hidden.has(n.role)) return null;
              const hl = !!matches && matches.has(n.path);
              let showLabel = hover === n.path || selected === n.path || (hl && matches!.size <= 12);
              if (!showLabel && k >= LABEL_ZOOM && labelsLeft > 0 && n.x >= lx0 && n.x <= lx1 && n.y >= ly0 && n.y <= ly1 && (!matches || hl) && (!neighbours || neighbours.has(n.path))) {
                showLabel = true;
                labelsLeft--;
              }
              const hl2 = hiddenLinksOf(n);
              return (
                <g key={n.path} opacity={nodeOpacity(n)}>
                  {hl2 > 0 && (
                    <circle cx={n.x} cy={n.y} r={n.r + 3} fill="none" stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" pointerEvents="none">
                      <title>{`${hl2} links hidden (role filter)`}</title>
                    </circle>
                  )}
                  <circle
                    data-testid={`code-map-node-${n.path}`}
                    data-hidden-links={hl2}
                    data-highlight={hl ? "true" : "false"}
                    cx={n.x} cy={n.y} r={n.r}
                    fill={COLORS[n.role]}
                    stroke={selected === n.path ? "#fff" : hl ? "#facc15" : "none"}
                    strokeWidth={selected === n.path || hl ? 2 : 0}
                    style={{ cursor: "pointer" }}
                    onPointerDown={(e) => onNodeDown(e, n)}
                    onPointerEnter={() => setHover(n.path)}
                    onPointerLeave={() => setHover(null)}
                  />
                  {showLabel && (
                    <text x={n.x + n.r + 2} y={n.y + 3 / k} fontSize={11 / k} fill="#e2e8f0" stroke="#0a0a0a" strokeWidth={2.5 / k} paintOrder="stroke" pointerEvents="none">
                      {n.path.split("/").pop()}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        {sel && (
          <aside data-testid="code-map-detail" className="w-full md:w-72 shrink-0 text-xs rounded border border-neutral-800 p-2 overflow-auto max-h-64 md:max-h-[560px]">
            <div className="font-mono break-all font-semibold" data-testid="code-map-detail-path">{sel.path}</div>
            <div className="mt-1"><span style={{ color: COLORS[sel.role] }}>●</span> {sel.role} · {sel.lines} lines</div>
            {sel.purpose && <div className="mt-1 opacity-80">{sel.purpose}</div>}
            <div className="mt-2 font-semibold">Imports ({sel.imports.length})</div>
            <ul>
              {sel.imports.map((p) => (
                <li key={p}><button type="button" className="text-left underline break-all" onClick={() => jump(p)}>{p}</button></li>
              ))}
            </ul>
            <div className="mt-2 font-semibold">Imported by ({sel.importedBy.length})</div>
            <ul>
              {sel.importedBy.map((p) => (
                <li key={p}><button type="button" className="text-left underline break-all" onClick={() => jump(p)}>{p}</button></li>
              ))}
            </ul>
            {sel.external.length > 0 && (
              <>
                <div className="mt-2 font-semibold">External packages ({sel.external.length})</div>
                <div className="break-all opacity-80">{sel.external.join(", ")}</div>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
