"use client";

import { useOwnerCell } from "@/components/CellContext";
import { useEffect, useRef, useState } from "react";
import { EmailPanel } from "./EmailPanel";
import { setOsContext } from "@/lib/os-context";
import { BUSINESS_TZ, fmtCentral } from "@/lib/time";

type Thread = {
  chat_id: number;
  guid: string;
  title: string;
  handles: string[];
  is_group: boolean;
  last_text: string | null;
  last_at: string | null;
  last_from_me: boolean;
  service: string;
};

type IMsg = {
  id: number;
  chat_id: number;
  text: string;
  from_me: boolean;
  sender: string;
  at: string | null;
  service: string;
  has_attachment: boolean;
};

type Contact = { id: string; name: string; org: string | null; phones: string[]; emails: string[] };

type EmailHit = { id: string; account: string; from: string; subject: string; date: string; snippet: string; text: string };

type SearchResults = {
  contacts: Contact[];
  messages: IMsg[];
  email: EmailHit[];
  access: boolean;
};

function when(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString("en-US", { timeZone: BUSINESS_TZ, hour: "numeric", minute: "2-digit" });
  if (now.getTime() - d.getTime() < 6 * 864e5) return d.toLocaleDateString("en-US", { timeZone: BUSINESS_TZ, weekday: "short" });
  return d.toLocaleDateString("en-US", { timeZone: BUSINESS_TZ, month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "2-digit" });
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.length > 140 ? text.slice(0, 140) + "…" : text;
  const s = Math.max(0, i - 50);
  return (
    <>
      {s > 0 && "…"}
      {text.slice(s, i)}
      <mark className="bg-gold/30 text-foreground rounded px-0.5">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length, i + q.length + 90)}
      {i + q.length + 90 < text.length && "…"}
    </>
  );
}

const blankThread = (chat_id: number, title: string, handles: string[] = []): Thread => ({
  chat_id,
  guid: "",
  title,
  handles,
  is_group: false,
  last_text: null,
  last_at: null,
  last_from_me: false,
  service: "iMessage",
});

export default function CommunicationsPage() {
  const owner = useOwnerCell(); // member cells: Email only (no Messages bridge, Job Engine or LinkedIn)
  const [tab, setTab] = useState<"inbox" | "email">(owner ? "inbox" : "email");
  // Deep link: /communications?tab=email (e.g. from the Team page's "email drafts waiting").
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    const h = window.location.hash.replace("#", "");
    // Jobs and LinkedIn tabs are not part of the showcase.
    if (t === "jobs" || t === "linkedin" || h === "jobs" || h === "linkedin") {
      window.location.replace("/communications");
      return;
    }
    // Old ?tab=outreach / ?tab=campaign links land on Email.
    if (t === "outreach" || t === "campaign") setTab("email");
    else if (t && (owner ? ["inbox", "email"] : ["email"]).includes(t)) setTab(t as typeof tab);
  }, []);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [noAccess, setNoAccess] = useState<string | null>(null);
  const [active, setActive] = useState<Thread | null>(null);
  const [newTo, setNewTo] = useState<Contact | null>(null);
  const [thread, setThread] = useState<IMsg[]>([]);
  // Tell the chat which tab (and, on Messages, which conversation) is open: titles/ids only.
  useEffect(() => {
    setOsContext(
      `${tab} tab` + (tab === "inbox" && active ? `; open conversation "${active.title}" (chat_id ${active.chat_id})` : ""),
      "tab"
    );
    return () => setOsContext(null, "tab");
  }, [tab, active?.chat_id, active?.title]);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  // Email search is slower (live Gmail connections), so it loads separately: null = still loading.
  const [emailHits, setEmailHits] = useState<EmailHit[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function loadThreads() {
    if (!owner) return;
    const res = await fetch("/api/imessage");
    const data = await res.json();
    if (res.status === 403) return setNoAccess(data.hint);
    setNoAccess(null);
    setThreads(data.threads || []);
  }

  async function loadThread(chatId: number) {
    const res = await fetch(`/api/imessage?chat=${chatId}`);
    const data = await res.json();
    setThread(data.messages || []);
  }

  useEffect(() => {
    loadThreads();
    const t = setInterval(loadThreads, 10000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!active) return;
    loadThread(active.chat_id);
    const t = setInterval(() => loadThread(active.chat_id), 5000);
    return () => clearInterval(t);
  }, [active?.chat_id]);

  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current) return; // only once per page load
    if (tab !== "inbox" || threads.length === 0) return; // wait for threads on the Messages tab
    if (active || newTo) return; // never override a thread already chosen
    const params = new URLSearchParams(window.location.search);
    if (params.get("chat") || params.get("thread")) return; // never override a URL-selected thread
    autoOpened.current = true;
    if (!window.matchMedia("(min-width: 768px)").matches) return; // mobile/narrow: keep list view
    setActive(threads[0]);
  }, [threads, tab, active, newTo]);

  useEffect(() => {
    if (focusId) document.getElementById(`msg-${focusId}`)?.scrollIntoView({ block: "center" });
    else bottomRef.current?.scrollIntoView();
  }, [thread, focusId]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setEmailHits(null);
      return;
    }
    setSearching(true);
    setEmailHits(null);
    // Each keystroke cancels the previous requests so stale answers never overwrite fresh ones.
    const ctrl = new AbortController();
    const local = setTimeout(async () => {
      try {
        if (!owner) { setSearching(false); return; }
        const res = await fetch(`/api/imessage?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        setResults(await res.json());
        setSearching(false);
      } catch {
        /* aborted by a newer keystroke */
      }
    }, 200);
    const email = setTimeout(async () => {
      try {
        const res = await fetch(`/api/imessage?q=${encodeURIComponent(q)}&scope=email`, { signal: ctrl.signal });
        setEmailHits((await res.json()).email || []);
      } catch {
        /* aborted by a newer keystroke */
      }
    }, 700);
    return () => {
      clearTimeout(local);
      clearTimeout(email);
      ctrl.abort();
    };
  }, [query]);

  function openThread(t: Thread, msgId: number | null = null) {
    setTab("inbox");
    setNewTo(null);
    setFocusId(msgId);
    setActive(t);
    setSendError(null);
  }

  function openChatId(chatId: number, msgId: number | null = null) {
    openThread(threads.find((x) => x.chat_id === chatId) || blankThread(chatId, "Conversation"), msgId);
  }

  async function openContact(c: Contact) {
    for (const h of [...c.phones, ...c.emails]) {
      const res = await fetch(`/api/imessage?handle=${encodeURIComponent(h)}`);
      const { chat_id } = await res.json();
      if (chat_id) {
        const t = threads.find((x) => x.chat_id === chat_id);
        return openThread(t ? { ...t, title: c.name } : blankThread(chat_id, c.name, [h]));
      }
    }
    // No history yet — start a new conversation.
    setTab("inbox");
    setActive(null);
    setThread([]);
    setNewTo(c);
  }

  async function send() {
    const text = draft.trim();
    if (!text) return;
    const body = newTo
      ? { to: newTo.phones[0] || newTo.emails[0], text }
      : active?.guid
      ? { chat_guid: active.guid, text }
      : { to: active?.handles[0], text };
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/imessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDraft("");
      setFocusId(null);
      setTimeout(() => {
        loadThreads();
        if (active) loadThread(active.chat_id);
      }, 1200);
    } catch (e: any) {
      setSendError(e.message);
    } finally {
      setSending(false);
    }
  }

  const q = query.trim();

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 md:px-8 pt-4 md:pt-8 pb-4 border-b border-panel-border space-y-4">
        <div className="flex flex-col md:flex-row md:items-end items-stretch justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl tracking-wide">Communications</h1>
            <p className="text-sm text-muted">{owner ? "Apple Messages, contacts, and email in one place." : "Email in one place."}</p>
          </div>
          <div className="flex w-full md:w-auto gap-1 bg-panel border border-panel-border rounded-lg p-1 text-sm overflow-x-auto">
            {(owner ? (["inbox", "email"] as const) : (["email"] as const)).map((t) => (
              <button
                key={t}
                data-testid={`${t}-tab`}
                onClick={() => {
                  setTab(t);
                  // Keep the URL's ?tab= in step so the chat's page hint never goes stale.
                  const url = new URL(window.location.href);
                  url.searchParams.set("tab", t);
                  window.history.replaceState(window.history.state, "", url.toString());
                }}
                className={`flex-1 md:flex-none px-4 py-2.5 md:py-1.5 rounded-md ${tab === t ? "bg-gold text-black font-semibold" : "text-muted hover:text-foreground"}`}
              >
                {t === "inbox"
                  ? "Messages"
                  : t === "email"
                  ? "Email"
                  : "Email"}
              </button>
            ))}
          </div>
        </div>
        <div className="relative">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search messages and contacts…"
            className="w-full bg-panel border border-panel-border rounded-lg pl-4 pr-10 py-2.5 text-sm outline-none focus:border-gold"
          />
          {q && (
            <button onClick={() => setQuery("")} className="absolute right-0 top-0 h-full w-11 text-muted hover:text-foreground text-sm">
              ✕
            </button>
          )}
        </div>
      </header>

      {q ? (
        <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-8">
          {searching && !results && <div className="text-sm text-muted">Searching…</div>}
          {results && (
            <>
              {!results.access && <AccessBanner />}
              <Section title="Contacts" count={results.contacts.length}>
                <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
                  {results.contacts.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setQuery("");
                        openContact(c);
                      }}
                      className="text-left bg-panel border border-panel-border rounded-lg p-3 hover:border-gold flex gap-3 items-center"
                    >
                      <Avatar name={c.name} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{highlight(c.name, q)}</div>
                        <div className="text-xs text-muted truncate">
                          {c.org && `${c.org} · `}
                          {c.phones[0] || c.emails[0] || "no handle"}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </Section>
              <Section title="Messages" count={results.messages.length}>
                <div className="space-y-1.5">
                  {results.messages.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        setQuery("");
                        openChatId(m.chat_id, m.id);
                      }}
                      className="w-full text-left bg-panel/60 border border-panel-border rounded-lg p-3 hover:border-gold text-sm"
                    >
                      <div className="flex justify-between text-xs text-muted mb-1">
                        <span>
                          {m.from_me ? "You" : m.sender}
                          {threads.find((t) => t.chat_id === m.chat_id) && ` · ${threads.find((t) => t.chat_id === m.chat_id)!.title}`}
                        </span>
                        <span>{when(m.at)}</span>
                      </div>
                      <div>{highlight(m.text, q)}</div>
                    </button>
                  ))}
                </div>
              </Section>
              <Section title="Email" count={emailHits?.length ?? 0} loading={emailHits === null}>
                <div className="space-y-1.5">
                  {(emailHits ?? []).map((m) => (
                    <button
                      key={`${m.account}:${m.id}`}
                      onClick={() => {
                        setQuery("");
                        setTab("email");
                      }}
                      className="w-full text-left bg-panel/60 border border-panel-border rounded-lg p-3 hover:border-gold text-sm"
                    >
                      <div className="flex justify-between text-xs text-muted mb-1">
                        <span>
                          {m.from} · {m.account}
                        </span>
                        <span>{when(m.date)}</span>
                      </div>
                      <div>{highlight(m.subject ? `${m.subject} — ${m.snippet}` : m.snippet, q)}</div>
                    </button>
                  ))}
                </div>
              </Section>
            </>
          )}
        </div>
      ) : tab === "email" ? (
        <EmailPanel />
      ) : noAccess ? (
        <div className="p-8">
          <AccessBanner />
        </div>
      ) : (
        <div className="flex-1 flex flex-col md:flex-row min-h-0">
          <div className="w-full md:w-80 shrink-0 max-h-[40dvh] md:max-h-none border-b md:border-b-0 md:border-r border-panel-border overflow-y-auto">
            {threads.map((t) => (
              <button
                key={t.chat_id}
                onClick={() => openThread(t)}
                className={`w-full text-left px-4 py-3 border-b border-panel-border/60 flex gap-3 ${
                  active?.chat_id === t.chat_id ? "bg-wash-3" : "hover:bg-wash-1"
                }`}
              >
                <Avatar name={t.title} group={t.is_group} />
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between gap-2">
                    <span className="text-sm font-medium truncate">{t.title}</span>
                    <span className="text-[11px] text-muted shrink-0">{when(t.last_at)}</span>
                  </div>
                  <div className="text-xs text-muted truncate">
                    {t.last_from_me && "You: "}
                    {t.last_text}
                  </div>
                </div>
              </button>
            ))}
            {threads.length === 0 && <div className="p-4 text-sm text-muted">Loading conversations…</div>}
          </div>

          <div className="flex-1 flex flex-col min-w-0">
            {active || newTo ? (
              <>
                <div className="px-4 md:px-6 py-3 border-b border-panel-border flex items-center gap-3">
                  <Avatar name={newTo?.name || active!.title} group={active?.is_group} />
                  <div>
                    <div className="text-sm font-medium">{newTo?.name || active!.title}</div>
                    <div className="text-xs text-muted">
                      {newTo
                        ? `New message · ${newTo.phones[0] || newTo.emails[0]}`
                        : `${active!.service} · ${active!.handles.join(", ")}`}
                    </div>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-4 space-y-1.5">
                  {thread.map((m, i) => {
                    const showSender = active?.is_group && !m.from_me && thread[i - 1]?.sender !== m.sender;
                    return (
                      <div key={m.id} id={`msg-${m.id}`} className={`flex flex-col ${m.from_me ? "items-end" : "items-start"}`}>
                        {showSender && <div className="text-[11px] text-muted ml-2 mt-2">{m.sender}</div>}
                        <div
                          title={fmtCentral(m.at)}
                          className={`max-w-[85%] md:max-w-[70%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words ${
                            m.from_me
                              ? m.service === "SMS"
                                ? "bg-emerald-600 text-white"
                                : "bg-blue text-white"
                              : "bg-panel border border-panel-border"
                          } ${focusId === m.id ? "ring-2 ring-gold" : ""}`}
                        >
                          {m.text || <span className="opacity-70">📎 Attachment</span>}
                        </div>
                      </div>
                    );
                  })}
                  <div ref={bottomRef} />
                </div>
                <div className="border-t border-panel-border p-4">
                  {sendError && <div className="text-xs text-danger mb-2">Send failed: {sendError}</div>}
                  <div className="flex gap-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          send();
                        }
                      }}
                      rows={1}
                      placeholder="iMessage"
                      className="flex-1 resize-none bg-panel border border-panel-border rounded-2xl px-4 py-2 text-sm outline-none focus:border-gold"
                    />
                    <button
                      onClick={send}
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
                Pick a conversation, or search for a contact to start one.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, count, loading, children }: { title: string; count: number; loading?: boolean; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm uppercase tracking-wide text-muted mb-3">
        {title} {loading ? "" : `(${count})`}
      </h2>
      {loading ? (
        <div className="text-sm text-muted/70">Searching…</div>
      ) : count === 0 ? (
        <div className="text-sm text-muted/70">No matches.</div>
      ) : (
        children
      )}
    </section>
  );
}

function Avatar({ name, group }: { name: string; group?: boolean }) {
  const initials = group
    ? "👥"
    : name
        .replace(/[^A-Za-z ]/g, "")
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0].toUpperCase())
        .join("") || "#";
  return (
    <div className="w-9 h-9 shrink-0 rounded-full bg-gradient-to-br from-gold/40 to-panel-border flex items-center justify-center text-xs font-semibold">
      {initials}
    </div>
  );
}

function AccessBanner() {
  return (
    <div className="bg-panel border border-gold/50 rounded-lg p-5 max-w-2xl">
      <div className="font-medium text-accent mb-1">Apple Messages isn&apos;t connected yet</div>
      <p className="text-sm text-muted mb-3">
        macOS protects Messages and Contacts. Give the dev server permission once:
      </p>
      <ol className="text-sm text-muted list-decimal ml-5 space-y-1">
        <li>Open System Settings → Privacy &amp; Security → Full Disk Access.</li>
        <li>Turn it on for the app that runs your dev server (Terminal, iTerm, VS Code, or Claude).</li>
        <li>Quit that app fully and restart <code className="text-foreground">npm run dev</code>.</li>
        <li>The first time you send, macOS asks to let it control Messages. Click Allow.</li>
      </ol>
    </div>
  );
}
