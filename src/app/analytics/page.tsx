"use client";
import { fmtCentral } from "@/lib/time";
import { setOsContext } from "@/lib/os-context";
import { useOwnerCell } from "@/components/CellContext";

import { useEffect, useState } from "react";
import CodeMapViews from "@/components/CodeMapViews";
import CleanupList from "@/components/CleanupList";

type Issue = {
  id: number;
  source: string;
  message: string;
  detail: string | null;
  created_at: string;
};

type Proposal = {
  id: number;
  title: string;
  diagnosis: string;
  proposed_change: string;
  files: string | null;
  status: string;
  result: string | null;
  size?: string | null;
  size_reasons?: string | null;
  cos_review?: string | null;
  created_at: string;
};

type MailAccount = {
  email: string;
  label: string;
  kind: "gmail_oauth" | "legacy_app_password";
  status: "connected" | "needs_reconnect";
  health?: {
    state: "ok" | "reconnecting" | "down";
    reason?: "credentials" | "network";
    last_ok_at: string | null;
    down_since: string | null;
    last_error: string | null;
  };
};

// SQLite stores UTC as 'YYYY-MM-DD HH:MM:SS'.
function parseSqlUtc(s: string) {
  return new Date(s.replace(" ", "T") + "Z");
}

function timeAgo(s: string | null) {
  if (!s) return "never";
  const min = Math.max(0, Math.round((Date.now() - parseSqlUtc(s).getTime()) / 60_000));
  return min < 1 ? "just now" : min === 1 ? "1 min ago" : min < 120 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

function clockTime(s: string | null) {
  return s ? parseSqlUtc(s).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "unknown";
}

function mailHealthText(h: NonNullable<MailAccount["health"]>) {
  if (h.state === "ok") return `Watching · checked ${timeAgo(h.last_ok_at)}`;
  if (h.reason === "credentials") return "App password rejected: create a new one in Google (see request)";
  const err = (h.last_error || "").slice(0, 120);
  if (h.state === "reconnecting") return `Reconnecting${h.down_since ? ` since ${clockTime(h.down_since)}` : ""} (network)`;
  return `Down since ${clockTime(h.down_since)}${err ? ` - ${err}` : ""}`;
}

type JobRow = Record<string, string>;
type Jobs = {
  found: boolean;
  pageId?: number;
  url?: string;
  stats?: { applications: number; interviews: number; offers: number };
  upcoming?: { company: string; label: string; date: string }[];
  applications?: JobRow[];
  interviews?: JobRow[];
};

// Turns "[text](url) · [text](url)" into safe links (http, https or relative only).
function jobLinks(cell: string): { text: string; url: string }[] {
  const out: { text: string; url: string }[] = [];
  for (const part of (cell || "").split(" · ")) {
    const m = part.trim().match(/^\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (m && /^(https?:\/\/|\/)/i.test(m[2])) out.push({ text: m[1] || m[2], url: m[2] });
  }
  return out;
}

function jobStatusColor(status: string): string {
  const s = (status || "").toLowerCase();
  if (/offer/.test(s)) return "text-success";
  if (/reject|declin/.test(s)) return "text-danger";
  if (/withdrawn|ghost/.test(s)) return "text-muted";
  if (/interview|final|recruiter/.test(s)) return "text-info";
  if (/applied|saved/.test(s)) return "text-accent";
  return "text-muted";
}

export default function AnalyticsPage() {
  const owner = useOwnerCell(); // member cells: no fixes / code map / cleanup / ops (self-build + server)
  const [issues, setIssues] = useState<Issue[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [tab, setTab] = useState<"overview" | "fixes" | "codemap" | "cleanup">("overview");
  const [openFix, setOpenFix] = useState<number | null>(null);
  const [reviewRunning,setReviewRunning] = useState(false);
  const [selectedIssues, setSelectedIssues] = useState<Set<number>>(new Set());
  const [checks, setChecks] = useState<string | null>(null);
  const [drive, setDrive] = useState<{ connected: boolean; configured: boolean } | null>(null);
  const [notion, setNotion] = useState<{ connected: boolean; workspace?: string | null; shared?: number; more?: boolean; error?: string } | null>(null);
  const [calendar, setCalendar] = useState<{ connected: boolean; configured: boolean } | null>(null);
  const [apple, setApple] = useState<{ configured: boolean } | null>(null);
  const [appleTest, setAppleTest] = useState<{ ok: boolean; calendars?: string[]; error?: string } | null>(null);
  const [appleTesting, setAppleTesting] = useState(false);
  const [mail, setMail] = useState<{ accounts: MailAccount[]; configured: boolean } | null>(null);
  const [connectLabel, setConnectLabel] = useState("");
  const [showConnect, setShowConnect] = useState(false);

  async function load() {
    if (owner) {
      const [issuesRes, opsRes] = await Promise.all([
        fetch("/api/issues"),
        fetch("/api/ops"),
      ]);
      setIssues((await issuesRes.json()).issues || []);
      const ops = await opsRes.json();
      setProposals(ops.proposals || []);
      setReviewRunning(!!ops.reviewRunning);
    }
    setDrive(await fetch("/api/google/auth?status=1").then((r) => r.json()));
    setCalendar(await fetch("/api/google/auth?status=1&service=calendar").then((r) => r.json()));
    setNotion(await fetch("/api/notion").then((r) => r.json()).catch(() => null));
    setApple(await fetch("/api/apple/auth?status=1").then((r) => r.json()));
    setMail(await fetch("/api/mail-accounts").then((r) => r.json()));
  }

  async function testAppleCalendar() {
    setAppleTesting(true);
    setAppleTest(null);
    try {
      const res = await fetch("/api/apple/auth?test=1");
      setAppleTest(await res.json());
    } finally {
      setAppleTesting(false);
    }
  }

  function gmailConnectHref() {
    const label = connectLabel.trim();
    return `/api/google/auth?service=gmail${label ? `&label=${encodeURIComponent(label)}` : ""}`;
  }

  async function disconnectGmail(email: string) {
    await fetch("/api/mail-accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disconnect", email }),
    });
    load();
  }

  async function ops(action: string, id?: number) {
    if (action === "test") setChecks("Running checks…");
    const res = await fetch("/api/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, id }),
    });
    const data = await res.json();
    if (action === "test")
      setChecks(data.ok ? `All ${data.passed} checks pass.` : `Failing: ${data.failed.join("; ")}`);
    load();
  }

  async function resolveIssue(id: number) {
    await fetch("/api/issues", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setSelectedIssues((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    load();
  }

  function toggleIssueSelected(id: number) {
    setSelectedIssues((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllIssues() {
    setSelectedIssues((prev) =>
      prev.size === issues.length ? new Set() : new Set(issues.map((i) => i.id))
    );
  }

  async function dismissSelectedIssues() {
    await fetch("/api/issues", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: Array.from(selectedIssues) }),
    });
    setSelectedIssues(new Set());
    load();
  }

  async function dismissAllIssues() {
    await fetch("/api/issues", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    setSelectedIssues(new Set());
    load();
  }

  useEffect(() => {
    if (window.location.hash === "#fixes") setTab("fixes");
    else if (window.location.hash === "#codemap") setTab("codemap");
    else if (window.location.hash === "#cleanup") setTab("cleanup");
    else if (window.location.hash === "#jobs" || window.location.hash === "#linkedin") {
      // These panels are not part of the showcase.
      window.location.replace("/analytics");
      return;
    }
    load();
    const interval = setInterval(load, 20000);
    return () => clearInterval(interval);
  }, []);

  // Tell the chat which tab / fix proposal / selection is showing (titles and ids only).
  const openProposal = openFix !== null ? proposals.find((p) => p.id === openFix) : undefined;
  useEffect(() => {
    const parts = [`${tab === "codemap" ? "Code Map" : tab === "cleanup" ? "Cleanup candidates" : tab} tab`];
    if (tab === "fixes" && openProposal) parts.push(`fix proposal #${openProposal.id} "${openProposal.title}" (${openProposal.status})`);
    if (selectedIssues.size > 0) parts.push(`${selectedIssues.size} issues selected`);
    setOsContext(parts.join("; "), "analytics");
    return () => setOsContext(null, "analytics");
  }, [tab, openProposal?.id, openProposal?.title, openProposal?.status, selectedIssues.size]);

  const needsAction = proposals.filter((p) => p.status === "pending_approval");
  const history = proposals.filter((p) => p.status !== "pending_approval");
  const applyingFix = history.find((p) => p.status === "applying");
  const recentFailed = history.find(
    (p) =>
      p.status === "failed" &&
      Date.now() - new Date(p.created_at.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(p.created_at) ? "" : "Z")).getTime() <
        24 * 3600 * 1000
  );
  const statusColor: Record<string, string> = {
    applying: "text-info",
    applied: "text-success",
    failed: "text-danger",
    dismissed: "text-muted",
    pending_cos_review: "text-accent",
    cos_approved: "text-info",
    sent_back: "text-muted",
    superseded: "text-muted",
    sent_to_github: "text-success",
  };
  function parseFiles(f: string) {
    try {
      return JSON.parse(f).join(", ");
    } catch {
      return f;
    }
  }
  function switchTab(t: "overview" | "fixes" | "codemap" | "cleanup") {
    setTab(t);
    window.history.replaceState(null, "", t !== "overview" ? `#${t}` : window.location.pathname);
  }

  return (
    <div className="p-8 space-y-8">
      <header>
        <h1 className="font-display text-2xl tracking-wide">Settings</h1>
        <p className="text-sm text-muted">{owner ? "Connections, fixes and system health." : "Connections."}</p>
      </header>

      <div className="flex gap-6 border-b border-panel-border text-sm">
        {(owner ? (["overview", "fixes", "codemap", "cleanup"] as const) : (["overview"] as const)).map((t) => (
          <button
            key={t}
            onClick={() => switchTab(t)}
            className={`pb-2 -mb-px border-b-2 ${
              tab === t ? "border-gold text-accent" : "border-transparent text-muted hover:bg-wash-2 rounded-t-lg"
            }`}
          >
            {t === "overview" ? "Overview" : t === "fixes" ? `Fixes (${history.length})` : t === "codemap" ? "Code Map" : "Cleanup candidates"}
          </button>
        ))}
      </div>

      {tab === "codemap" && <div data-testid="codemap-panel"><CodeMapViews /></div>}
      {tab === "cleanup" && <CleanupList />}

      {tab === "fixes" && (
        <div className="bg-panel border border-panel-border rounded-lg divide-y divide-panel-border">
          {history.length === 0 && <div className="p-5 text-sm text-muted">No fixes yet.</div>}
          {history.map((p) => (
            <div key={p.id} data-testid="fix-row" className="text-sm">
              <button
                onClick={() => setOpenFix(openFix === p.id ? null : p.id)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-wash-1"
              >
                <span className="text-muted text-xs w-10 shrink-0">#{p.id}</span>
                <span className="flex-1 truncate">{p.title}</span>
                <span className={`text-xs shrink-0 ${statusColor[p.status] || "text-muted"}`}>{p.status}</span>
                <span className="text-xs text-muted shrink-0">{fmtCentral(p.created_at, { weekday: undefined, hour: undefined, minute: undefined, timeZoneName: undefined })}</span>
              </button>
              {openFix === p.id && (
                <div data-testid="fix-details" className="px-4 pb-4 space-y-2">
                  <div className="text-muted">{p.diagnosis}</div>
                  {p.files && <div className="text-xs text-muted">{parseFiles(p.files)}</div>}
                  {p.result && <div className="text-xs whitespace-pre-wrap">{p.result}</div>}
                  <div className="max-h-64 overflow-auto bg-wash-2 rounded p-2 text-xs whitespace-pre-wrap">
                    {p.proposed_change}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "overview" && (<>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {owner && <button
          onClick={() => ops("test")}
          className="border border-panel-border rounded px-3 py-1.5 hover:border-gold"
        >
          Run checks now
        </button>}
        {owner && <button
          onClick={() => ops("review")}
          disabled={reviewRunning}
          className="border border-panel-border rounded px-3 py-1.5 hover:border-gold disabled:opacity-50"
        >
          {reviewRunning ? "Ops review running…" : "Run ops review now"}
        </button>}
        {drive &&
          (drive.connected ? (
            <span className="border border-success/50 text-success rounded px-3 py-1.5">Google Drive connected</span>
          ) : drive.configured ? (
            <a href="/api/google/auth" className="bg-gold text-black font-semibold rounded px-3 py-1.5 hover:bg-gold-soft">
              Connect Google Drive
            </a>
          ) : (
            <span className="border border-panel-border text-muted rounded px-3 py-1.5" title="Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.local">
              Google Drive: needs setup
            </span>
          ))}
        {calendar &&
          (calendar.connected ? (
            <span className="border border-success/50 text-success rounded px-3 py-1.5">Google Calendar connected</span>
          ) : calendar.configured ? (
            <a
              href="/api/google/auth?service=calendar"
              className="bg-gold text-black font-semibold rounded px-3 py-1.5 hover:bg-gold-soft"
            >
              Connect Google Calendar
            </a>
          ) : (
            <span className="border border-panel-border text-muted rounded px-3 py-1.5" title="Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.local">
              Google Calendar: needs setup
            </span>
          ))}
        {notion &&
          (notion.connected ? (
            <span
              className="border border-success/50 text-success rounded px-3 py-1.5"
              title="Share more pages with the integration in Notion: page → ••• → Connections"
              data-testid="notion-status"
            >
              Notion connected{notion.workspace ? ` (${notion.workspace})` : ""} · {notion.shared}
              {notion.more ? "+" : ""} shared
            </span>
          ) : (
            <span
              className="border border-panel-border text-muted rounded px-3 py-1.5"
              title={notion.error || "Create an internal integration at notion.so/my-integrations and put its token in NOTION_TOKEN in .env.local"}
              data-testid="notion-status"
            >
              Notion: needs setup
            </span>
          ))}
        {apple &&
          (apple.configured ? (
            <button
              onClick={testAppleCalendar}
              disabled={appleTesting}
              data-testid="test-apple-calendar"
              className={`rounded px-3 py-1.5 border ${
                appleTest?.ok ? "border-emerald-800 text-emerald-400" : "border-panel-border hover:border-gold"
              }`}
            >
              {appleTesting
                ? "Testing…"
                : appleTest?.ok
                ? `Apple Calendar connected (${appleTest.calendars?.join(", ")})`
                : "Test Apple Calendar connection"}
            </button>
          ) : (
            <span className="border border-panel-border text-muted rounded px-3 py-1.5" title="Add APPLE_ID and an app-specific APPLE_APP_PASSWORD to .env.local">
              Apple Calendar: needs setup
            </span>
          ))}
        {appleTest && appleTest.ok === false && (
          <span className="text-red-400" data-testid="apple-calendar-error">
            {appleTest.error}
          </span>
        )}
        {checks && <span className="text-muted">{checks}</span>}
      </div>

      <div className="bg-panel border border-panel-border rounded-lg p-5" data-testid="connected-accounts">
        <div className="flex items-center justify-between gap-4 mb-3">
          <h2 className="text-sm uppercase tracking-wide text-muted">Connected email accounts</h2>
          {mail?.configured ? (
            showConnect ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={connectLabel}
                  onChange={(e) => setConnectLabel(e.target.value)}
                  placeholder="label, e.g. business or personal"
                  className="bg-wash-2 border border-panel-border rounded px-2.5 py-1.5 text-xs outline-none focus:border-gold w-48"
                />
                <a
                  href={gmailConnectHref()}
                  className="bg-gold text-black text-xs font-semibold px-3 py-1.5 rounded hover:bg-gold-soft"
                >
                  Continue to Google
                </a>
                <button
                  onClick={() => setShowConnect(false)}
                  className="text-xs text-muted hover:text-foreground px-1"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowConnect(true)}
                className="bg-gold text-black text-xs font-semibold px-3 py-1.5 rounded hover:bg-gold-soft"
              >
                Connect Gmail
              </button>
            )
          ) : (
            <span
              className="text-xs border border-panel-border text-muted rounded px-3 py-1.5"
              title="Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.local"
            >
              Needs setup
            </span>
          )}
        </div>
        <p className="text-xs text-muted mb-3">
          Scope granted on connect: read, send, label, and archive mail — never permanently delete.
        </p>
        {!mail || mail.accounts.length === 0 ? (
          <div className="text-sm text-muted">
            No email accounts connected yet. Click Connect Gmail above to sign in with Google.
          </div>
        ) : (
          <div className="divide-y divide-panel-border">
            {mail.accounts.map((a) => (
              <div key={a.email} data-testid="mail-account-row" className="flex items-center justify-between gap-4 py-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate">
                    {a.label} <span className="text-muted">· {a.email}</span>
                  </div>
                  {a.kind === "legacy_app_password" && a.health ? (
                    <div
                      data-testid="mail-health"
                      className={`text-xs ${
                        a.health.state === "ok"
                          ? "text-success"
                          : a.health.state === "reconnecting"
                          ? "text-gold"
                          : "text-danger"
                      }`}
                    >
                      {mailHealthText(a.health)}
                    </div>
                  ) : (
                    <div
                      className={`text-xs ${
                        a.status === "needs_reconnect"
                          ? "text-danger"
                          : a.kind === "legacy_app_password"
                          ? "text-muted"
                          : "text-success"
                      }`}
                    >
                      {a.status === "needs_reconnect"
                        ? "Needs reconnect"
                        : a.kind === "legacy_app_password"
                        ? "Connected (legacy app password)"
                        : "Connected"}
                    </div>
                  )}
                </div>
                {a.kind === "gmail_oauth" && (
                  <button
                    onClick={() => disconnectGmail(a.email)}
                    className="text-xs shrink-0 border border-panel-border rounded px-2 py-1 hover:border-danger/50 hover:text-danger"
                  >
                    Disconnect
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {applyingFix && <div className="text-xs text-muted">Applying: {applyingFix.title}...</div>}
      {recentFailed && (
        <button onClick={() => switchTab("fixes")} className="block text-xs text-danger hover:underline">
          Fix failed: {recentFailed.title}, see Fixes tab
        </button>
      )}

      {needsAction.length > 0 && (
        <div className="bg-panel border border-gold/40 rounded-lg p-5">
          <h2 className="text-sm uppercase tracking-wide text-accent mb-3">Proposed fixes</h2>
          <div className="space-y-4">
            {needsAction.map((p) => (
              <div key={p.id} data-testid="proposal-card" className="text-sm border-b border-panel-border pb-4 last:border-0 last:pb-0">
                <div className="flex items-start justify-between gap-4">
                  <div className="font-medium"><span data-testid="proposal-number" className="text-muted text-xs mr-2">#{p.id}</span>{p.title}</div>
                  <span className="text-xs text-muted shrink-0">{p.status.replace(/_/g, " ")}</span>
                </div>
                {p.cos_review && <div className="text-xs mt-1 text-accent">{p.cos_review}</div>}
                {p.size === "major" && p.size_reasons && <div className="text-xs text-muted mt-1">Major change: {p.size_reasons}</div>}
                <div className="text-muted mt-1">{p.diagnosis}</div>
                <div className="mt-2 bg-wash-2 rounded p-2 text-xs whitespace-pre-wrap">{p.proposed_change}</div>
                {p.files && <div className="text-xs text-muted mt-1">{JSON.parse(p.files).join(", ")}</div>}
                {p.result && <div className="text-xs mt-2 whitespace-pre-wrap">{p.result}</div>}
                {p.status === "pending_approval" && (
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => ops("approve", p.id)}
                      className="bg-gold text-black text-xs font-semibold px-3 py-1.5 rounded hover:bg-gold-soft"
                    >
                      Approve &amp; apply
                    </button>
                    <button
                      onClick={() => ops("dismiss", p.id)}
                      className="border border-panel-border text-xs px-3 py-1.5 rounded hover:border-gold"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {issues.length > 0 && (
        <div className="bg-panel border border-danger/50 rounded-lg p-5">
          <h2 className="text-sm uppercase tracking-wide text-danger mb-3">
            Needs attention ({issues.length})
          </h2>
          <div className="flex items-center justify-between gap-4 mb-3">
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={issues.length > 0 && selectedIssues.size === issues.length}
                onChange={toggleSelectAllIssues}
              />
              Select all
            </label>
            <div className="flex items-center gap-2">
              <button
                onClick={dismissSelectedIssues}
                disabled={selectedIssues.size === 0}
                className="text-xs shrink-0 border border-panel-border rounded px-2 py-1 hover:border-gold disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Dismiss selected ({selectedIssues.size})
              </button>
              <button
                onClick={dismissAllIssues}
                className="text-xs shrink-0 border border-panel-border rounded px-2 py-1 hover:border-gold"
              >
                Dismiss all
              </button>
            </div>
          </div>
          <div className="space-y-2">
            {issues.map((issue) => (
              <div
                key={issue.id}
                data-testid="issue-row"
                className="flex items-start justify-between gap-4 text-sm border-b border-panel-border pb-2 last:border-0 last:pb-0"
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selectedIssues.has(issue.id)}
                    onChange={() => toggleIssueSelected(issue.id)}
                  />
                  <div>
                    <div className="text-foreground">{issue.message}</div>
                    <div className="text-muted text-xs mt-0.5">
                      {issue.source} · {fmtCentral(issue.created_at)}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => resolveIssue(issue.id)}
                  className="text-xs shrink-0 border border-panel-border rounded px-2 py-1 hover:border-gold"
                >
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      </>)}
    </div>
  );
}
