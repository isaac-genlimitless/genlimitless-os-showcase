"use client";

import { useEffect, useState } from "react";
import { fmtCentral } from "@/lib/time";
import { setOsContext } from "@/lib/os-context";
import { emailSrcdoc } from "@/lib/email-html";

type MailAccount = {
  email: string;
  label: string;
  kind: "gmail_oauth" | "legacy_app_password";
  status: "connected" | "needs_reconnect";
};

type EmailMessage = {
  id: string;
  threadId?: string;
  account: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  text: string;
  messageIdHeader?: string;
  references?: string;
  html?: string;
  hasRemoteImages?: boolean;
};

// Shows the sanitized HTML in a sandboxed iframe (no scripts, opaque origin); plain text otherwise.
function EmailBody({ m }: { m: EmailMessage }) {
  const [plain, setPlain] = useState(false);
  const [loadImages, setLoadImages] = useState(false);
  useEffect(() => {
    setPlain(false);
    setLoadImages(false);
  }, [m.id]);
  const plainDiv = <div className="whitespace-pre-wrap">{m.text || m.snippet}</div>;
  if (!m.html) return plainDiv;
  return (
    <div>
      <div className="flex justify-end mb-1">
        <button
          type="button"
          data-testid="email-view-toggle"
          onClick={() => setPlain((p) => !p)}
          className="text-xs text-accent hover:underline"
        >
          {plain ? "Formatted" : "Plain text"}
        </button>
      </div>
      {plain ? (
        plainDiv
      ) : (
        <>
          {m.hasRemoteImages && !loadImages && (
            <div className="flex items-center gap-2 text-xs text-muted mb-2">
              <span>Remote images are blocked to protect your privacy.</span>
              <button
                type="button"
                data-testid="email-load-images"
                onClick={() => setLoadImages(true)}
                className="border border-panel-border rounded px-2 py-0.5 hover:border-gold"
              >
                Load images
              </button>
            </div>
          )}
          <iframe
            data-testid="email-html-frame"
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            srcDoc={emailSrcdoc(m.html, { loadImages })}
            title="Email content"
            className="w-full min-h-[200px] h-[70vh] max-h-[75vh] resize-y overflow-auto bg-white rounded border border-panel-border"
          />
        </>
      )}
    </div>
  );
}

type EmailDraft = {
  id: number;
  account: string;
  to_addr: string;
  subject: string;
  body: string;
  in_reply_to: string | null;
  reason: string | null;
  created_by: string;
  error: string | null;
  created_at: string;
};

const AGENT_NAMES: Record<string, string> = { chief_of_staff: "Chief" };

// One agent-drafted email waiting for Owner: edit anything, then Approve & send or Discard.
function DraftCard({ d, accounts, onDone }: { d: EmailDraft; accounts: MailAccount[]; onDone: () => void }) {
  const [to, setTo] = useState(d.to_addr);
  const [subject, setSubject] = useState(d.subject);
  const [body, setBody] = useState(d.body);
  const [busy, setBusy] = useState<"approve" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(d.error);

  async function act(action: "approve" | "discard") {
    if (action === "discard" && !confirm("Discard this draft? (It's kept in the record, just never sent.)")) return;
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/email-drafts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: d.id, action, to, subject, body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bg-panel border border-panel-border rounded-lg p-4 space-y-2 text-sm" data-testid={`email-draft-${d.id}`}>
      <div className="text-xs text-muted">
        From {accountLabel(d.account, accounts)} · drafted by {AGENT_NAMES[d.created_by] || d.created_by} · {fmtCentral(d.created_at)}
        {d.in_reply_to && " · reply in thread"}
      </div>
      {d.reason && <div className="text-xs text-accent">{d.reason}</div>}
      <input value={to} onChange={(e) => setTo(e.target.value)} className="w-full bg-wash-2 border border-panel-border rounded px-2 py-1.5 outline-none focus:border-gold" placeholder="To" />
      <input value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full bg-wash-2 border border-panel-border rounded px-2 py-1.5 outline-none focus:border-gold" placeholder="Subject" />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={Math.min(14, Math.max(5, body.split("\n").length + 1))} className="w-full bg-wash-2 border border-panel-border rounded px-2 py-1.5 outline-none focus:border-gold" />
      {error && <div className="text-xs text-danger">{error}</div>}
      <div className="flex gap-2">
        <button onClick={() => act("approve")} disabled={!!busy} className="bg-gold text-black text-xs font-semibold px-3 py-1.5 rounded hover:bg-gold-soft disabled:opacity-50">
          {busy === "approve" ? "Sending…" : "Approve & send"}
        </button>
        <button onClick={() => act("discard")} disabled={!!busy} className="border border-panel-border text-xs px-3 py-1.5 rounded hover:border-gold disabled:opacity-50">
          Discard
        </button>
      </div>
    </div>
  );
}

function extractEmail(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim();
}

function accountLabel(email: string, accounts: MailAccount[]) {
  return accounts.find((a) => a.email === email)?.label || email;
}

export function EmailPanel() {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [configured, setConfigured] = useState(true);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [filter, setFilter] = useState<string | null>(null);
  const [active, setActive] = useState<EmailMessage | null>(null);
  const [thread, setThread] = useState<EmailMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [showDrafts, setShowDrafts] = useState(false);

  // Tell the chat which email is open (subject / sender / account / id only, never the body).
  useEffect(() => {
    setOsContext(
      active
        ? `open email "${active.subject}" from ${active.from} (account ${active.account}, message id ${active.id})`
        : `email list, filter ${filter ?? "all accounts"}`,
      "email"
    );
    return () => setOsContext(null, "email");
  }, [active?.id, active?.subject, active?.from, active?.account, filter]);

  async function loadDrafts() {
    const data = await fetch("/api/email-drafts").then((r) => r.json()).catch(() => ({ drafts: [] }));
    setDrafts(data.drafts || []);
  }
  useEffect(() => {
    loadDrafts();
    const t = setInterval(() => { if (!document.hidden) loadDrafts(); }, 30000);
    return () => clearInterval(t);
  }, []);

  async function loadAccounts() {
    const data = await fetch("/api/mail-accounts").then((r) => r.json());
    setAccounts(data.accounts || []);
    setConfigured(!!data.configured);
    setAccountsLoaded(true);
  }

  async function loadMessages() {
    const params = new URLSearchParams();
    if (filter) params.set("account", filter);
    const data = await fetch(`/api/email?${params}`).then((r) => r.json());
    setMessages(data.messages || []);
  }

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    if (!accountsLoaded || accounts.length === 0) return;
    loadMessages();
    const t = setInterval(() => { if (!document.hidden) loadMessages(); }, 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, accountsLoaded, accounts.length]);

  async function openMessage(m: EmailMessage) {
    setShowDrafts(false);
    setActive(m);
    setDraft("");
    setSendError(null);
    if (m.threadId) {
      const data = await fetch(
        `/api/email?thread=${encodeURIComponent(m.threadId)}&account=${encodeURIComponent(m.account)}`
      ).then((r) => r.json());
      setThread(data.messages || []);
    } else {
      setThread([m]);
    }
  }

  async function reply() {
    if (!active || !draft.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: active.account,
          to: extractEmail(active.from),
          subject: /^re:/i.test(active.subject) ? active.subject : `Re: ${active.subject}`,
          text: draft.trim(),
          threadId: active.threadId,
          inReplyTo: active.messageIdHeader,
          references: [active.references, active.messageIdHeader].filter(Boolean).join(" "),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDraft("");
      loadMessages();
    } catch (e: any) {
      setSendError(e.message);
    } finally {
      setSending(false);
    }
  }

  if (!accountsLoaded) return <div className="p-8 text-sm text-muted">Loading…</div>;

  if (accounts.length === 0) {
    return (
      <div className="p-8" data-testid="email-empty-state">
        <EmailSetupBanner configured={configured} />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col md:flex-row min-h-0">
      <div className="w-full md:w-80 shrink-0 max-h-[45dvh] md:max-h-none border-b md:border-b-0 md:border-r border-panel-border flex flex-col min-h-0">
        <button
          onClick={() => setShowDrafts(true)}
          data-testid="email-drafts-toggle"
          className={`w-full text-left px-4 py-2.5 border-b border-panel-border text-sm flex justify-between ${showDrafts ? "bg-wash-3 text-accent" : "hover:bg-wash-1"}`}
        >
          <span>Drafts waiting for you</span>
          <span className={drafts.length ? "text-accent font-semibold" : "text-muted"}>{drafts.length}</span>
        </button>
        <div className="p-3 flex flex-wrap gap-1.5 border-b border-panel-border">
          <button
            onClick={() => setFilter(null)}
            className={`text-xs px-2.5 py-1 rounded-full border ${
              filter === null
                ? "bg-gold text-black border-gold font-semibold"
                : "border-panel-border text-muted hover:text-foreground"
            }`}
          >
            All
          </button>
          {accounts.map((a) => (
            <button
              key={a.email}
              onClick={() => setFilter(a.email)}
              className={`text-xs px-2.5 py-1 rounded-full border ${
                filter === a.email
                  ? "bg-gold text-black border-gold font-semibold"
                  : "border-panel-border text-muted hover:text-foreground"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto">
          {messages.length === 0 && <div className="p-4 text-sm text-muted">No messages yet.</div>}
          {messages.map((m) => (
            <button
              key={`${m.account}:${m.id}`}
              onClick={() => openMessage(m)}
              className={`w-full text-left px-4 py-3 border-b border-panel-border/60 ${
                active?.id === m.id && active?.account === m.account ? "bg-wash-3" : "hover:bg-wash-1"
              }`}
            >
              <div className="flex justify-between gap-2">
                <span className="text-sm font-medium truncate">{m.from}</span>
                <span className="text-[11px] text-muted shrink-0">
                  {fmtCentral(m.date, { weekday: undefined, timeZoneName: undefined })}
                </span>
              </div>
              <div className="text-xs text-accent truncate">{accountLabel(m.account, accounts)}</div>
              <div className="text-xs text-muted truncate">{m.subject || "(no subject)"}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        {showDrafts ? (
          <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 space-y-4">
            <div className="text-sm text-muted">Emails your agents drafted. Nothing goes out until you approve it.</div>
            {drafts.length === 0 && <div className="text-sm text-muted">Nothing waiting.</div>}
            {drafts.map((d) => (
              <DraftCard key={d.id} d={d} accounts={accounts} onDone={loadDrafts} />
            ))}
          </div>
        ) : active ? (
          <>
            <div className="px-4 md:px-6 py-3 border-b border-panel-border">
              <div className="text-sm font-medium">{active.subject || "(no subject)"}</div>
              <div className="text-xs text-muted">Account: {accountLabel(active.account, accounts)}</div>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {thread.map((m) => (
                <div key={m.id} className="bg-panel border border-panel-border rounded-lg p-3 text-sm">
                  <div className="flex justify-between text-xs text-muted mb-1">
                    <span>{m.from}</span>
                    <span>{fmtCentral(m.date)}</span>
                  </div>
                  <EmailBody m={m} />
                </div>
              ))}
            </div>
            <div className="border-t border-panel-border p-4">
              {sendError && <div className="text-xs text-danger mb-2">Send failed: {sendError}</div>}
              <div className="flex gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={2}
                  placeholder={`Reply from ${accountLabel(active.account, accounts)}`}
                  className="flex-1 resize-none bg-panel border border-panel-border rounded-2xl px-4 py-2 text-sm outline-none focus:border-gold"
                />
                <button
                  onClick={reply}
                  disabled={sending || !draft.trim()}
                  className="bg-gold text-black text-sm font-semibold px-4 rounded-2xl hover:bg-gold-soft disabled:opacity-40"
                >
                  {sending ? "…" : "Send"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-muted">
            Pick an email to read the thread.
          </div>
        )}
      </div>
    </div>
  );
}

function EmailSetupBanner({ configured }: { configured: boolean }) {
  return (
    <div className="bg-panel border border-gold/50 rounded-lg p-5 max-w-2xl">
      <div className="font-medium text-accent mb-1">No email accounts connected yet</div>
      {configured ? (
        <>
          <p className="text-sm text-muted mb-3">Connect a Gmail account in Settings to see mail here.</p>
          <a
            href="/analytics"
            className="inline-block text-sm bg-gold text-black font-semibold px-3 py-1.5 rounded hover:bg-gold-soft"
          >
            Go to Settings → Connect Gmail
          </a>
        </>
      ) : (
        <p className="text-sm text-muted">
          Add <code className="text-foreground">GOOGLE_CLIENT_ID</code> and{" "}
          <code className="text-foreground">GOOGLE_CLIENT_SECRET</code> to .env.local, then connect Gmail from
          Settings.
        </p>
      )}
    </div>
  );
}
