import cron from "node-cron";

// Append-only sweeper: when a new fix proposal touches the same files or topic as another one from the
// last 24h, a clearly marked note is appended to its diagnosis. Never rejects, blocks or changes scope.

export type OverlapRow = {
  id: number;
  title: string;
  status: string;
  files?: string | null;
  created_at: string;
  proposed_by?: string | null;
  retry_of?: number | null;
  supersedes?: number | null;
  diagnosis?: string;
};
export type Overlap = { id: number; title: string; status: string; minutesAgo: number; sharedFiles: string[]; sharedWords: string[] };

const DAY_MS = 24 * 3600_000;
const MARK = "[overlap-check]";
const STOP = new Set([
  "fixes", "proposal", "change", "changes", "build", "make", "when", "after", "before", "stop", "which", "their", "there",
  "about", "while", "should", "would", "could", "using", "being", "update", "issue", "problem", "page", "pages",
]);

function ts(s: string): number {
  const t = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? Date.parse(s) : Date.parse(s.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t : NaN;
}
function fileSet(r: OverlapRow): Set<string> {
  try {
    const a = JSON.parse(r.files || "[]");
    return new Set(Array.isArray(a) ? a.map((f) => String(f).replace(/^\.\//, "")) : []);
  } catch {
    return new Set();
  }
}
function words(title: string): Set<string> {
  return new Set((title.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 5 && !STOP.has(w)));
}
function chain(row: OverlapRow, all: OverlapRow[]): Set<number> {
  const byId = new Map(all.map((r) => [r.id, r]));
  byId.set(row.id, row);
  const seen = new Set<number>([row.id]);
  let frontier = [row.id];
  for (let depth = 0; depth < 5 && frontier.length; depth++) {
    const next: number[] = [];
    for (const r of byId.values()) {
      for (const id of frontier) {
        const cur = byId.get(id)!;
        const links = [cur.retry_of, cur.supersedes].filter((x): x is number => typeof x === "number");
        for (const l of links) if (!seen.has(l)) { seen.add(l); next.push(l); }
        if ((r.retry_of === id || r.supersedes === id) && !seen.has(r.id)) { seen.add(r.id); next.push(r.id); }
      }
    }
    frontier = next;
  }
  return seen;
}

export function findOverlaps(row: OverlapRow, others: OverlapRow[], now: number = Date.now()): Overlap[] {
  const own = chain(row, others);
  const myFiles = fileSet(row);
  const myWords = words(row.title);
  const out: (Overlap & { t: number })[] = [];
  for (const o of others) {
    if (own.has(o.id)) continue;
    if (o.proposed_by === "cleanup" || o.status === "dismissed" || o.status === "superseded") continue;
    const t = ts(o.created_at);
    if (!Number.isFinite(t) || now - t > DAY_MS) continue;
    const sharedFiles = [...fileSet(o)].filter((f) => myFiles.has(f));
    const sharedWords = [...words(o.title)].filter((w) => myWords.has(w));
    if (!sharedFiles.length && sharedWords.length < 3) continue;
    out.push({ id: o.id, title: o.title, status: o.status, minutesAgo: Math.max(0, Math.round((now - t) / 60_000)), sharedFiles, sharedWords, t });
  }
  out.sort((a, b) => b.t - a.t || b.id - a.id);
  return out.slice(0, 6).map(({ t: _t, ...rest }) => rest);
}

export function noteFor(overlaps: Overlap[]): string {
  const parts = overlaps.map((o) => {
    const bits = [o.status, `${o.minutesAgo} min ago`];
    if (o.sharedFiles.length) bits.push(`shares ${o.sharedFiles.join(", ")}`);
    if (o.sharedWords.length) bits.push(`words: ${o.sharedWords.join(", ")}`);
    return `#${o.id} "${o.title}" (${bits.join("; ")})`;
  });
  let n = `\n\n${MARK} Heads-up (automatic): other proposals in the last 24h touch the same area: ${parts.join(", ")}. Decide whether this replaces, depends on, or duplicates them. If it is the Nth attempt at one problem, say so in the review.`;
  if (overlaps.length >= 3) n += " This is at least the 4th attempt on this area: prefer one consolidated proposal.";
  return n;
}

type Db = { prepare: (sql: string) => { all: (...a: any[]) => any[]; run: (...a: any[]) => any } };
const seenNoOverlap = new Set<number>();

export function sweepOverlaps(db: Db, now: number = Date.now()): number {
  const recent = db
    .prepare(
      `SELECT id, title, status, files, created_at, proposed_by, retry_of, supersedes, diagnosis FROM fix_proposals WHERE created_at >= datetime('now','-1 day') ORDER BY id DESC LIMIT 300`
    )
    .all() as OverlapRow[];
  let changed = 0;
  for (const r of recent) {
    if (r.status !== "pending_cos_review" || (r.diagnosis || "").includes(MARK) || seenNoOverlap.has(r.id)) continue;
    const ov = findOverlaps(r, recent, now);
    if (!ov.length) {
      const t = ts(r.created_at);
      if (Number.isFinite(t) && now - t > 10 * 60_000) seenNoOverlap.add(r.id);
      continue;
    }
    const res: any = db
      .prepare(`UPDATE fix_proposals SET diagnosis = diagnosis || ? WHERE id=? AND status='pending_cos_review' AND diagnosis NOT LIKE '%[overlap-check]%'`)
      .run(noteFor(ov), r.id);
    if (!res || res.changes === undefined || res.changes > 0) changed++;
  }
  return changed;
}

export function startOverlapWatch() {
  const g = globalThis as { __fixOverlapWatch?: boolean };
  if (g.__fixOverlapWatch) return;
  g.__fixOverlapWatch = true;
  const tick = async () => {
    try {
      const { default: db } = await import("./db");
      sweepOverlaps(db as unknown as Db);
    } catch (e: any) {
      try {
        const { logIssue } = await import("./db");
        logIssue("fix_overlap", "Overlap check failed", String(e?.message || e).slice(0, 300));
      } catch {}
    }
  };
  cron.schedule("* * * * *", () => void tick(), { timezone: "America/Chicago" });
  void tick();
}
