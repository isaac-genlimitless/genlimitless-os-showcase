// Read-only text snapshots of what each tab of the OS shows, so agents can see what Owner sees.
// Every tab is built from the same GET endpoints its page loads (via the server's own base URL);
// Nothing here writes:
// the only network call is `getJson` below, which issues plain GET requests.

export const UI_TABS = [
  "home",
  "team",
  "activity",
  "communications.messages",
  "communications.email",
  "analytics",
  "calendar",
  "tasks",
  "meetings",
  "files",
  "research",
  "software-dev",
] as const;
export type UiTab = (typeof UI_TABS)[number];

export type Snapshot = { tab: UiTab; source_endpoints: string[]; summary: Record<string, unknown>; items: unknown[]; notes?: string[] };
export type SnapshotOpts = { limit?: number; baseUrl?: string };

const MAX_STR = 160;
const MAX_JSON_CHARS = 24_000;

function baseUrl(opts?: SnapshotOpts): string {
  return (opts?.baseUrl || process.env.OS_BASE_URL || `http://localhost:${process.env.PORT || 3100}`).replace(/\/$/, "");
}

async function getJson(base: string, endpoint: string): Promise<{ ok: boolean; data: any; error?: string }> {
  try {
    const res = await fetch(base + endpoint, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, data, error: `${endpoint} returned ${res.status}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, data: null, error: `${endpoint} failed: ${(e as Error).message}` };
  }
}

/** Shrinks any JSON value: long strings clipped, arrays cut to `limit` rows (with a count of the rest), depth capped. */
function compact(v: unknown, limit: number, depth = 0): unknown {
  if (typeof v === "string") return v.length > MAX_STR ? v.slice(0, MAX_STR) + `… (+${v.length - MAX_STR} chars)` : v;
  if (Array.isArray(v)) {
    const rows = v.slice(0, limit).map((x) => compact(x, Math.min(limit, 10), depth + 1));
    return v.length > limit ? { count: v.length, first: rows, more: v.length - limit } : rows;
  }
  if (v && typeof v === "object") {
    if (depth >= 3) return `{${Object.keys(v as object).length} keys}`;
    return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, compact(x, limit, depth + 1)]));
  }
  return v;
}

function arrayOf(data: any, key: string): any[] {
  const v = data?.[key];
  return Array.isArray(v) ? v : Array.isArray(data) ? data : [];
}

/** What a tab shows right now, compactly. Never throws for an unreachable endpoint: the failure is reported in notes. */
export async function snapshotTab(tab: UiTab, opts: SnapshotOpts = {}): Promise<Snapshot> {
  const limit = Math.max(1, Math.min(opts.limit ?? 15, 50));
  const base = baseUrl(opts);
  const notes: string[] = [];
  const endpoints: string[] = [];

  async function load(endpoint: string): Promise<any> {
    endpoints.push(endpoint);
    const r = await getJson(base, endpoint);
    if (!r.ok) notes.push(r.error || `${endpoint} failed`);
    return r.data;
  }
  const finish = (summary: Record<string, unknown>, items: unknown[]): Snapshot => {
    let snap: Snapshot = { tab, source_endpoints: endpoints, summary, items, ...(notes.length ? { notes } : {}) };
    if (JSON.stringify(snap).length > MAX_JSON_CHARS) {
      const kept = items.slice(0, Math.max(1, Math.floor(items.length / 3)));
      snap = { ...snap, items: kept, notes: [...notes, `output capped: showing ${kept.length} of ${items.length} items; lower limit or read the endpoint directly`] };
    }
    return snap;
  };

  switch (tab) {
    case "team": {
      const d = await load("/api/agents");
      const agents = arrayOf(d, "agents");
      return finish(
        {
          agents: agents.length,
          open_escalations: arrayOf(d, "escalations").length,
          pending_approvals: arrayOf(d, "approvals").length,
          major_fixes_awaiting_owner: d?.majorFixes ?? null,
          email_drafts_pending: d?.emailDrafts ?? null,
        },
        agents.slice(0, limit).map((a) => ({ slug: a.slug, name: a.name, title: a.title, status: a.status, tools: Array.isArray(a.tools) ? a.tools.length : null }))
      );
    }
    case "activity": {
      const d = await load("/api/runs");
      const runs = arrayOf(d, "runs");
      return finish({ runs: runs.length, usage_today: compact(d?.today, 3), usage_week: compact(d?.week, 3) }, runs.slice(0, limit).map((r) => compact(r, 5)));
    }
    case "communications.messages": {
      const d = await load("/api/imessage");
      return finish({ note: "Apple Messages inbox (needs Full Disk Access on the server; an error appears in notes if not granted)" }, [compact(d, limit)]);
    }
    case "communications.email": {
      const drafts = await load("/api/email-drafts");
      const accounts = await load("/api/mail-accounts");
      const list = arrayOf(drafts, "drafts");
      const accts = arrayOf(accounts, "accounts");
      return finish(
        { email_drafts: list.length, mail_accounts: accts.length },
        list.slice(0, limit).map((x) => compact(x, 3))
      );
    }
    case "analytics": {
      const issues = await load("/api/issues");
      const ops = await load("/api/ops");
      return finish({ note: "Settings: issues, fixes and ops" }, [{ issues: compact(issues, limit) }, { ops: compact(ops, limit) }]);
    }
    case "calendar": {
      const now = Date.now();
      const start = new Date(now - 24 * 3600_000).toISOString();
      const end = new Date(now + 7 * 24 * 3600_000).toISOString();
      const d = await load(`/api/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
      const events = arrayOf(d, "events");
      return finish({ window: "yesterday through the next 7 days", events: events.length }, events.slice(0, limit).map((e) => compact(e, 3)));
    }
    case "tasks": {
      const d = await load("/api/tasks?status=all");
      const items = arrayOf(d, "tasks");
      const open = items.filter((t) => t.status === "open").length;
      return finish({ open, done: items.length - open }, items.slice(0, limit).map((t) => compact(t, 3)));
    }
    case "meetings": {
      const m = await load("/api/meetings");
      const upcoming = await load("/api/calendar?now=1");
      const list = arrayOf(m, "meetings");
      return finish({ meetings: list.length, happening_now: compact(upcoming, 3) }, list.slice(0, limit).map((x) => compact(x, 3)));
    }
    case "files": {
      const d = await load("/api/files");
      const recent = arrayOf(d, "recent");
      return finish({ top_level_entries: arrayOf(d, "tree").length, recent_files: recent.length }, [{ recent: compact(recent, limit) }, { tree: compact(arrayOf(d, "tree"), limit) }]);
    }
    case "home":
      return finish({ note: "The home page is the chat with the Chief of Staff; there is no separate data endpoint to snapshot. Use search_chat_history for conversation content." }, []);
    case "research":
    case "software-dev":
      return finish({ note: `The ${tab} page is static text with no data endpoint.` }, []);
  }
}
