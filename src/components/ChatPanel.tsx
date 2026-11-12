"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type AnchorHTMLAttributes } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import { parseScheduleReview } from "@/lib/schedule-review";
import { ScheduleReviewModal } from "@/components/ScheduleReviewModal";
import { getOsContext, getScreenText } from "@/lib/os-context";
import { CHAT_EFFORTS, CHAT_MODELS, NO_EFFORT_MODEL, chatEffort, chatModel } from "@/lib/chat-options";
import { formatBytes, validateChatFiles } from "@/lib/chat-upload-limits";
import { buildPasteText } from "@/lib/paste-links";
import LiveWork from "./LiveWork";
import { useDictation } from "./useDictation";
import { TextDraftCard } from "./TextDraftCard";
import { UndoTurnButton } from "./UndoTurnButton";
import { MentionPicker, type PickerEntry } from "./MentionPicker";

// Image thumbnail for a pending attachment; the object URL is revoked when the chip goes away.
function FileThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="" className="h-6 w-6 rounded object-cover" /> : null;
}

// Safe subset of HTML: defaults (headings, lists, tables, links, img, code, blockquote, etc.) plus collapsible sections. Scripts, iframes, event handlers and inline styles stay stripped.
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary", "mark", "kbd"],
};

// Hoisted so the arrays keep the same identity across renders (inline arrays force every
// ReactMarkdown instance to re-parse its message on every keystroke).
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS: React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"] = [rehypeRaw, [rehypeSanitize, sanitizeSchema]];

// Only render the newest messages; older ones load on demand. Rendering + parsing hundreds of
// markdown bubbles is what made typing lag.
const VISIBLE_STEP = 60;

type Attachment = { name: string; path: string; mimeType: string; size: number };
type ChatMessage = {
  id?: number;
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  meta?: { type: "pr"; number: number } | { type: "text_draft"; id: number } | null;
  undo?: { state: "none" | "available" | "undone" } | null;
};

type PR = {
  number: number;
  title: string;
  url: string;
  state: string;
  body: string;
  additions: number;
  deletions: number;
  files: { path: string; additions: number; deletions: number }[];
  checks: { name: string; status: string; conclusion: string | null }[];
  error?: string;
};

function checkLabel(c: PR["checks"][number]) {
  if (c.status !== "COMPLETED") return { icon: "⏳", cls: "text-muted" };
  if (c.conclusion === "SUCCESS" || c.conclusion === "SKIPPED" || c.conclusion === "NEUTRAL") return { icon: "✓", cls: "text-success" };
  return { icon: "✗", cls: "text-danger" };
}

type DeployInfo = {
  enabled: boolean;
  live?: string | null;
  latest?: string | null;
  behind?: boolean;
  status?: { state: string; message: string } | null;
};

// Server only: after a merge, shows whether the live server is behind GitHub and offers a confirmed Deploy.
// One shared poller for every DeployBar on the page (each merged PR card renders one; they used to poll separately,
// which was ~4 requests/second and made the phone take minutes to load).
let deployInfo: DeployInfo | null = null;
const deploySubs = new Set<(i: DeployInfo | null) => void>();
let deployTimer: ReturnType<typeof setInterval> | null = null;
let deployLoading = false;

async function loadDeployInfo() {
  if (deployLoading) return;
  deployLoading = true;
  try {
    deployInfo = await fetch("/api/deploy").then((r) => r.json());
    deploySubs.forEach((fn) => fn(deployInfo));
  } catch {
    // The server restarts mid-deploy; keep showing the last status and retry.
  } finally {
    deployLoading = false;
  }
}

function useDeployInfo() {
  const [info, setInfo] = useState<DeployInfo | null>(deployInfo);
  useEffect(() => {
    deploySubs.add(setInfo);
    if (!deployTimer) {
      loadDeployInfo();
      deployTimer = setInterval(() => {
        if (!document.hidden) loadDeployInfo();
      }, 10000);
    } else if (deployInfo) {
      setInfo(deployInfo);
    }
    return () => {
      deploySubs.delete(setInfo);
      if (deploySubs.size === 0 && deployTimer) {
        clearInterval(deployTimer);
        deployTimer = null;
      }
    };
  }, []);
  return info;
}

function DeployBar({ standalone = false }: { standalone?: boolean }) {
  const info = useDeployInfo();
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = loadDeployInfo;

  if (!info?.enabled) return null;
  const running = info.status?.state === "running";
  if (standalone && !running && !info.behind && !(info.status && info.status.state !== "idle" && info.status.state !== "done")) return null;

  async function deploy() {
    if (!confirm("Deploy the latest merged code to the live server?\n\nIt builds on the side, checks it works, backs up the database, then restarts (a few seconds). If the new version doesn't start, it rolls back by itself.")) return;
    setStarting(true);
    setErr(null);
    try {
      const r = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deploy" }),
      }).then((r) => r.json());
      if (r.error) setErr(r.error);
      await load();
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className={standalone ? "text-xs px-4 py-2 border-b border-panel-border bg-panel" : "text-xs mt-3 border-t border-panel-border pt-2"} data-testid="deploy-bar">
      {running ? (
        <span>Deploying… {info.status?.message}</span>
      ) : info.behind ? (
        <div className="flex items-center gap-2">
          <span className="text-muted">The server is behind GitHub.</span>
          <button onClick={deploy} disabled={starting} className="bg-gold text-black font-semibold px-3 py-1.5 rounded hover:bg-gold-soft disabled:opacity-50">
            Deploy to server
          </button>
        </div>
      ) : (
        <span className="text-success">✓ The server is running the latest version.</span>
      )}
      {!running && info.status && info.status.state !== "idle" && info.status.state !== "done" && (
        <div className="text-danger mt-1">Last deploy: {info.status.message}</div>
      )}
      {err && <div className="text-danger mt-1">{err}</div>}
    </div>
  );
}

// A pull request posted into chat: live status, what changed, and Merge / Close.
function PRCard({ number }: { number: number }) {
  const [pr, setPr] = useState<PR | null>(null);
  const [busy, setBusy] = useState<"merge" | "close" | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const prRef = useRef<PR | null>(null);
  async function load() {
    const d = await fetch(`/api/github?pr=${number}`).then((r) => r.json());
    prRef.current = d;
    setPr(d);
  }
  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.hidden) return; // nobody's looking
      if (prRef.current && prRef.current.state !== "OPEN") return; // merged/closed PRs never change
      load();
    }, 30000);
    return () => clearInterval(t);
  }, [number]);

  async function act(action: "merge" | "close") {
    if (action === "merge" && !confirm(`Merge #${number}? (On the server this only merges on GitHub; you deploy separately.)`)) return;
    setBusy(action);
    try {
      const r = await fetch("/api/github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, number }),
      }).then((r) => r.json());
      setResult(r.message || r.error || (r.ok ? "Done." : "Something went wrong."));
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!pr) return <div className="text-xs text-muted mt-2">Loading pull request…</div>;
  if (pr.error) return <div className="text-xs text-danger mt-2">Couldn&apos;t load PR #{number}: {pr.error}</div>;
  const summary = pr.body.replace(/^Fixes #\d+\s*/, "").split("\n").filter((l) => l.trim() && !l.startsWith("- [")).slice(0, 8).join("\n");

  return (
    <div className="mt-3 border border-panel-border rounded-lg p-3 bg-wash-2 not-prose" data-testid={`pr-card-${number}`}>
      <div className="flex items-start justify-between gap-3">
        <a href={pr.url} target="_blank" rel="noreferrer" className="font-medium hover:text-accent">
          #{pr.number} {pr.title}
        </a>
        <span className={`text-[11px] shrink-0 border rounded px-1.5 py-0.5 ${pr.state === "OPEN" ? "border-gold text-accent" : pr.state === "MERGED" ? "border-success/50 text-success" : "border-panel-border text-muted"}`}>
          {pr.state.toLowerCase()}
        </span>
      </div>
      {summary && <div className="text-xs text-muted mt-2 whitespace-pre-wrap line-clamp-6">{summary}</div>}
      <button onClick={() => setOpen(!open)} className="text-xs text-muted mt-2 hover:text-foreground">
        {pr.files.length} file{pr.files.length === 1 ? "" : "s"} changed · <span className="text-success">+{pr.additions}</span>{" "}
        <span className="text-danger">−{pr.deletions}</span> {open ? "▾" : "▸"}
      </button>
      {open && (
        <ul className="text-xs mt-1 space-y-0.5">
          {pr.files.map((f) => (
            <li key={f.path} className="font-mono">
              {f.path} <span className="text-success">+{f.additions}</span> <span className="text-danger">−{f.deletions}</span>
            </li>
          ))}
        </ul>
      )}
      {pr.checks.length > 0 && (
        <div className="flex flex-wrap gap-x-3 text-xs mt-2">
          {pr.checks.map((c, i) => {
            const l = checkLabel(c);
            return <span key={i} className={l.cls}>{l.icon} {c.name}</span>;
          })}
        </div>
      )}
      {pr.state === "OPEN" && (
        <div className="flex gap-2 mt-3">
          <button onClick={() => act("merge")} disabled={!!busy} className="bg-gold text-black text-xs font-semibold px-3 py-1.5 rounded hover:bg-gold-soft disabled:opacity-50">
            {busy === "merge" ? "Merging, pulling & testing…" : "Merge & pull"}
          </button>
          <a href={`${pr.url}/files`} target="_blank" rel="noreferrer" className="border border-panel-border text-xs px-3 py-1.5 rounded hover:border-gold">
            View diff
          </a>
          <button onClick={() => act("close")} disabled={!!busy} className="border border-panel-border text-xs px-3 py-1.5 rounded hover:border-gold disabled:opacity-50">
            Close
          </button>
        </div>
      )}
      {result && <div className="text-xs mt-2">{result}</div>}
      {pr.state === "MERGED" && <DeployBar />}
    </div>
  );
}

function AttachmentChip({ att }: { att: Attachment }) {
  const url = `/api/uploads/${att.path}`;
  if (att.mimeType.startsWith("image/")) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block mt-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={att.name} className="max-h-48 rounded border border-panel-border" />
      </a>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mt-2 inline-flex items-center gap-1 text-xs underline opacity-80 hover:opacity-100"
    >
      📎 {att.name}
    </a>
  );
}

// @ mention chips are links to /files?id=N, /meetings?id=N, /tasks?id=N (see src/lib/mentions.ts).
const MENTION_HREF_RE = /^\/(files|meetings|tasks)\?id=\d+$/;
// Strip characters that would break a markdown link label.
const cleanLabel = (s: string) => s.replace(/[\[\]()\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

// Links to the OS's own pages (e.g. a page in Files) navigate in place, so the docked chat stays
// open; outside links open in a new tab.
function ChatLink({ href = "", children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href.startsWith("/") && !href.startsWith("//")) {
    const chip = MENTION_HREF_RE.test(href);
    return (
      <Link href={href} {...rest} {...(chip ? { className: "mention-chip", "data-testid": "mention-chip" } : {})}>
        {children}
      </Link>
    );
  }
  return <a href={href} {...rest} target="_blank" rel="noopener noreferrer">{children}</a>;
}
const MD_COMPONENTS = { a: ChatLink };

// memo: while Owner types, `messages` is unchanged, so no bubble re-renders or re-parses markdown.
const MessageBubble = memo(function MessageBubble({
  m,
  onReviewSchedule,
  onUndoChanged,
}: {
  m: ChatMessage;
  onReviewSchedule: (date: string) => void;
  onUndoChanged?: () => void;
}) {
  const isUser = m.role === "user";
  const schedule = !isUser ? parseScheduleReview(m.content) : null;
  const showUndo = !isUser && !!m.id && !!m.undo;
  const bubble = (
      <div
        className={`min-w-0 ${showUndo ? "max-w-full" : "max-w-[92%]"} md:max-w-2xl break-words rounded-lg px-4 py-3 text-sm markdown-body ${
          isUser ? "bg-gold text-black" : "bg-panel border border-panel-border text-foreground"
        }`}
      >
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={MD_COMPONENTS}
        >
          {schedule ? schedule.stripped : m.content}
        </ReactMarkdown>
        {m.attachments?.map((att, i) => <AttachmentChip key={i} att={att} />)}
        {schedule && (
          <button
            onClick={() => onReviewSchedule(schedule.date)}
            className="mt-2 text-xs font-semibold bg-gold text-black rounded px-3 py-1.5 hover:bg-gold-soft"
          >
            Review schedule
          </button>
        )}
        {m.meta?.type === "pr" && <PRCard number={m.meta.number} />}
        {m.meta?.type === "text_draft" && <TextDraftCard id={m.meta.id} />}
      </div>
  );
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      {showUndo && m.undo ? (
        <div className="flex flex-col items-start min-w-0 max-w-[92%] md:max-w-2xl">
          {bubble}
          <UndoTurnButton chatId={m.id as number} state={m.undo.state} onChanged={onUndoChanged ?? (() => {})} />
        </div>
      ) : (
        bubble
      )}
    </div>
  );
});

type Thread = { id: number; title: string | null };
const ICON_BTN = "shrink-0 h-9 w-9 flex items-center justify-center border rounded-full";
const MODEL_KEY = "chat-model";
const EFFORT_KEY = "chat-effort";
const keyOf = (thread: number | null) => (thread ? String(thread) : "main");

// The Chief of Staff chat. Full page on /, and docked as a sidebar on every other page (ChatDock),
// sharing the same conversations, so Owner can ask about whatever he's looking at.
export default function ChatPanel({ variant = "full", onClose }: { variant?: "full" | "dock"; onClose?: () => void }) {
  const dock = variant === "dock";
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const dictation = useDictation(input, setInput);
  // "@" picker: `mention` is the text typed after the @ (null = closed); `from` is where the @ is.
  const [mention, setMention] = useState<{ query: string; from: number } | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  const mentionEntries = useRef<PickerEntry[]>([]);
  const mentionLinks = useRef<Map<string, string>>(new Map()); // label -> href, for what was picked
  function detectMention(el: HTMLTextAreaElement) {
    const caret = el.selectionStart ?? el.value.length;
    const m = /(^|\s)@([^\s@]{0,40})$/.exec(el.value.slice(0, caret));
    if (!m) {
      if (mention) setMention(null);
      return;
    }
    if (!mention || mention.query !== m[2]) setMentionActive(0);
    if (!mention || mention.query !== m[2] || mention.from !== caret - m[2].length - 1) setMention({ query: m[2], from: caret - m[2].length - 1 });
  }
  function pickMention(entry: PickerEntry) {
    const el = textareaRef.current;
    if (!mention || !el) return;
    const caret = el.selectionStart ?? el.value.length;
    const insert = `@${entry.label} `;
    const next = el.value.slice(0, mention.from) + insert + el.value.slice(caret);
    if (entry.href) mentionLinks.current.set(entry.label, entry.href);
    setInput(next);
    setMention(null);
    const pos = mention.from + insert.length;
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    }, 0);
  }
  /** At send time: "@Label" that is still in the text becomes a markdown link to the item. */
  function withMentionLinks(text: string): string {
    let out = text;
    const labels = [...mentionLinks.current.keys()].sort((a, b) => b.length - a.length);
    for (const label of labels) {
      const clean = cleanLabel(label);
      const href = mentionLinks.current.get(label)!;
      const re = new RegExp(`(^|\\s)@${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`);
      out = out.replace(re, (_m, pre) => `${pre}[@${clean}](${href})`);
    }
    return out;
  }
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const fileErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which conversation is on screen (null = main chat), the open side chats, and which
  // conversations have a reply in flight (from the server, so it survives a reload).
  const [thread, setThread] = useState<number | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [running, setRunning] = useState<string[]>([]);
  const [hasVoice, setHasVoice] = useState<boolean | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [reviewScheduleDate, setReviewScheduleDate] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(VISIBLE_STEP);
  // Model and effort for the next message ("" = the OS default). Remembered in this browser and
  // shared by the full chat and the dock.
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  useEffect(() => {
    try {
      setModel(chatModel(localStorage.getItem(MODEL_KEY)) ?? "");
      setEffort(chatEffort(localStorage.getItem(EFFORT_KEY)) ?? "");
    } catch {}
  }, []);
  function pick(key: string, value: string, set: (v: string) => void) {
    set(value);
    try {
      localStorage.setItem(key, value);
    } catch {}
  }
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const settledKeyRef = useRef<string | null>(null);
  const prevLenRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Touch / narrow screens: Return inserts a newline, only the send button sends.
  const coarseRef = useRef(false);
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const qs = [window.matchMedia("(pointer: coarse)"), window.matchMedia("(max-width: 767px)")];
    const update = () => { const v = qs.some((q) => q.matches); coarseRef.current = v; setCoarse(v); };
    update();
    qs.forEach((q) => q.addEventListener("change", update));
    return () => qs.forEach((q) => q.removeEventListener("change", update));
  }, []);
  const threadRef = useRef<number | null>(null);
  threadRef.current = thread;
  const loading = running.includes(keyOf(thread));
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [input]);

  const chatUrl = (t: number | null) => (t ? `/api/chat?thread=${t}` : "/api/chat");

  // Local "sending" marks win over the server's list until the reply comes back.
  const sendingRef = useRef<Set<string>>(new Set());
  function applyServer(d: { threads?: Thread[]; running?: string[] }) {
    if (d.threads) setThreads(d.threads);
    if (d.running) setRunning([...new Set([...d.running, ...sendingRef.current])]);
  }

  async function openThread(t: number | null) {
    setThread(t);
    setMessages([]);
    setVisibleCount(VISIBLE_STEP);
    const d = await fetch(chatUrl(t)).then((r) => r.json()).catch(() => null);
    if (!d || threadRef.current !== t) return;
    setMessages(d.messages || []);
    applyServer(d);
  }

  async function refreshCurrent() {
    const t = threadRef.current;
    const d = await fetch(chatUrl(t)).then((r) => r.json()).catch(() => null);
    if (!d || threadRef.current !== t) return;
    setMessages(d.messages || []);
    applyServer(d);
  }

  // Stable wrapper so MessageBubble's memo isn't defeated on every render.
  const refreshCurrentRef = useRef(refreshCurrent);
  refreshCurrentRef.current = refreshCurrent;
  const stableRefreshCurrent = useCallback(() => {
    void refreshCurrentRef.current();
  }, []);

  useEffect(() => {
    openThread(null);
    fetch("/api/voice")
      .then((r) => r.json())
      .then((d) => setHasVoice(!!d.profile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pick up messages the OS posts on its own (pull requests, briefings, merged side chats) and
  // replies that finished while Owner was looking at another chat.
  const anyRunning = running.length > 0;
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.hidden) return;
      const viewing = threadRef.current;
      const d = await fetch(chatUrl(viewing)).then((r) => r.json()).catch(() => null);
      if (!d || threadRef.current !== viewing) return;
      applyServer(d);
      if (sendingRef.current.has(keyOf(viewing))) return;
      const server: ChatMessage[] = d.messages || [];
      setMessages((cur) => {
        const lastServer = server.at(-1)?.id;
        const lastLocal = [...cur].reverse().find((m) => m.id)?.id;
        return lastServer && lastServer !== lastLocal ? server : cur;
      });
    }, anyRunning ? 4000 : 15000);
    return () => clearInterval(t);
     
  }, [anyRunning]);

  async function newChat() {
    const d = await fetch("/api/chat/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json());
    setThreads((cur) => [...cur, d.thread]);
    await openThread(d.thread.id);
    textareaRef.current?.focus();
  }

  async function closeChat(t: Thread) {
    if (!confirm(`Close "${t.title || "New chat"}"? Its conversation gets merged into the main chat.`)) return;
    const res = await fetch(`/api/chat/threads?id=${t.id}`, { method: "DELETE" });
    const d = await res.json();
    if (!res.ok) return alert(d.error || "Couldn't close that chat.");
    setThreads((cur) => cur.filter((x) => x.id !== t.id));
    if (threadRef.current === t.id) await openThread(null);
    else if (threadRef.current === null) await openThread(null);
  }

  async function refreshVoiceProfile() {
    if (hasVoice && !confirm("Rebuild your voice guide from scratch from your Sent mail? Rules you've taught it are kept, and the current guide is backed up. (Everyday changes don't need this: just tell Chief what to change.)")) return;
    setVoiceBusy(true);
    try {
      const res = await fetch("/api/voice", { method: "POST" });
      const data = await res.json();
      if (data.profile) setHasVoice(true);
      else alert(data.error || "Could not build a voice profile.");
    } finally {
      setVoiceBusy(false);
    }
  }

  useLayoutEffect(() => {
    const el = bottomRef.current?.parentElement; if (!el) return;
    const key = String(thread ?? "main");
    const firstForThread = settledKeyRef.current !== key;
    if (firstForThread) {
      el.style.scrollBehavior = "auto"; el.scrollTop = el.scrollHeight; // instant, before paint
      if (messages.length > 0) { settledKeyRef.current = key; stickRef.current = true; }
    } else if (stickRef.current && messages.length >= prevLenRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" }); // only for new messages after load
    }
    prevLenRef.current = messages.length;
  }, [messages, loading, thread]);
  useEffect(() => {
    const el = bottomRef.current?.parentElement; if (!el) return;
    const onScroll = () => { stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; };
    const follow = () => { if (stickRef.current) { el.style.scrollBehavior = "auto"; el.scrollTop = el.scrollHeight; } };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("load", follow, true); // images
    el.addEventListener("toggle", follow, true); // details blocks
    const mo = new MutationObserver(follow); mo.observe(el, { childList: true, subtree: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(follow) : null; Array.from(el.children).forEach((c) => ro?.observe(c));
    return () => { el.removeEventListener("scroll", onScroll); el.removeEventListener("load", follow, true); el.removeEventListener("toggle", follow, true); mo.disconnect(); ro?.disconnect(); };
  }, [thread]);

  function addFiles(list: File[]) {
    if (list.length === 0) return;
    const pendingBytes = pendingFiles.reduce((s, f) => s + f.size, 0);
    const { ok, rejected } = validateChatFiles(list, pendingFiles.length, pendingBytes);
    if (ok.length > 0) setPendingFiles((prev) => [...prev, ...ok.map((i) => list[i])]);
    if (fileErrorTimer.current) clearTimeout(fileErrorTimer.current);
    if (rejected.length > 0) {
      setFileError(rejected.map((r) => r.reason).join(" · "));
      fileErrorTimer.current = setTimeout(() => setFileError(null), 8000);
    } else {
      setFileError(null);
    }
  }

  async function send() {
    const text = withMentionLinks(input.trim());
    if ((!text && pendingFiles.length === 0) || loading) return;
    mentionLinks.current = new Map();
    setMention(null);

    const sentThread = thread;
    const key = keyOf(sentThread);
    const here = () => threadRef.current === sentThread;
    const filesToSend = pendingFiles;
    setInput("");
    setPendingFiles([]);

    let userMessageIndex = -1;
    setMessages((m) => {
      userMessageIndex = m.length;
      return [
        ...m,
        {
          role: "user",
          content: text,
          attachments: filesToSend.map((f) => ({
            name: f.name,
            path: "",
            mimeType: f.type,
            size: f.size,
          })),
        },
      ];
    });
    sendingRef.current.add(key);
    setRunning((r) => [...new Set([...r, key])]);
    // The first message names a new side chat on the server; mirror it in the tab right away.
    if (sentThread) setThreads((cur) => cur.map((t) => (t.id === sentThread && !t.title ? { ...t, title: text.slice(0, 40) } : t)));
    try {
      const form = new FormData();
      form.set("message", text);
      if (sentThread) form.set("thread_id", String(sentThread));
      const context = getOsContext();
      if (context) form.set("context", context);
      const screen = getScreenText();
      if (screen) form.set("screen", screen);
      form.set("surface", variant === "dock" ? "sidebar" : "main");
      if (model) form.set("model", model);
      if (effort && model !== NO_EFFORT_MODEL) form.set("effort", effort);
      filesToSend.forEach((f) => form.append("files", f));

      const res = await fetch("/api/chat", { method: "POST", body: form });
      const data = await res.json();
      if (!here()) return; // Owner switched chats; the reply is saved and shows when he comes back.

      if (!res.ok) {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: data.error || "Something went wrong sending that." },
        ]);
        return;
      }

      // Swap in the real, saved attachment paths now that the upload finished —
      // the optimistic entry above has empty paths, which can't actually load.
      if (data.attachments?.length) {
        setMessages((m) =>
          m.map((msg, i) => (i === userMessageIndex ? { ...msg, attachments: data.attachments } : msg))
        );
      }

      setMessages((m) => [...m, { role: "assistant", content: data.reply || data.error }]);
    } catch (err: any) {
      if (here()) setMessages((m) => [...m, { role: "assistant", content: `Error: ${err.message}` }]);
    } finally {
      sendingRef.current.delete(key);
      setRunning((r) => r.filter((k) => k !== key));
    }
  }

  return (
    <div
      className="flex flex-col h-full relative"
      data-testid="chat-panel-root"
      onDragEnter={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {dragging && (
        <div
          data-testid="chat-dropzone"
          className="absolute inset-0 z-50 pointer-events-none flex items-center justify-center border-2 border-dashed border-gold bg-black/60 text-gold text-sm"
        >
          Drop files to attach to your message
        </div>
      )}
      <DeployBar standalone />
      {dock ? (
        <header className="px-4 py-3 border-b border-panel-border flex items-center justify-between gap-2">
          <div className="font-display text-lg tracking-wide">Chief</div>
          <div className="flex items-center gap-2">
            <Link href="/" className="text-xs text-muted hover-pill" title="Open the full chat">Full chat ↗</Link>
            <button onClick={onClose} aria-label="Close chat" title="Close (⌘J)" className="text-muted hover:bg-wash-2 rounded-lg px-1">✕</button>
          </div>
        </header>
      ) : (
      <header className="px-4 md:px-8 py-2 md:py-5 border-b border-panel-border flex flex-row items-center justify-between gap-3 md:gap-4">
        <div>
          <h1 className="font-display text-xl md:text-2xl tracking-wide">Chief</h1>
          <p className="hidden md:block text-sm text-muted" data-testid="chat-header-description">
            Runs your team of agents and brings you what needs your approval. Busy on something?
            Open a new chat for a quick side task; closing it merges it back into Main.
          </p>
        </div>
        <button
          onClick={refreshVoiceProfile}
          disabled={voiceBusy}
          title="Learns your writing voice from your Gmail Sent folder"
          className="shrink-0 text-xs border border-panel-border rounded px-3 py-2 max-w-[9.5rem] md:max-w-none hover:border-gold disabled:opacity-50"
        >
          {voiceBusy
            ? "Learning your voice…"
            : hasVoice
            ? "Voice guide ✓ · Rebuild"
            : "Learn my voice from Sent mail"}
        </button>
      </header>
      )}

      <div className={`${dock ? "px-3" : "px-3 md:px-8"} pt-3 border-b border-panel-border flex items-end gap-1 overflow-x-auto`} data-testid="chat-tabs">
        {[{ id: null as number | null, title: "Main" }, ...threads].map((t) => {
          const active = thread === t.id;
          const busy = running.includes(keyOf(t.id));
          return (
            <div
              key={t.id ?? "main"}
              className={`group flex items-center gap-2 px-3 py-2.5 text-sm rounded-t border border-b-0 shrink-0 max-w-56 ${
                active ? "bg-panel border-panel-border text-accent" : "border-transparent text-muted hover:bg-wash-2"
              }`}
            >
              <button onClick={() => !active && openThread(t.id)} className="truncate" data-testid={`chat-tab-${t.id ?? "main"}`}>
                {busy && <span className="inline-block w-1.5 h-1.5 rounded-full bg-gold animate-pulse mr-2 align-middle" title="Working…" />}
                {t.title || "New chat"}
              </button>
              {t.id !== null && (
                <button
                  onClick={() => closeChat(t as Thread)}
                  title="Close and merge into Main"
                  aria-label={`Close ${t.title || "New chat"}`}
                  className="text-muted hover-pill text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        <button
          onClick={newChat}
          className="px-3 py-2 text-sm text-muted hover:bg-wash-2 rounded-lg shrink-0"
          title="Open a side chat for another task"
        >
          + New chat
        </button>
      </div>

      <div data-testid="chat-messages" className={`flex-1 min-w-0 overflow-y-auto ${dock ? "px-4 py-4" : "px-8 py-6"} space-y-4`}>
        {messages.length === 0 && !loading && thread !== null && (
          <div className="text-muted text-sm">
            Side chat. Ask for anything while Main keeps working. When you&apos;re done, close it with ✕ and it merges into Main.
          </div>
        )}
        {messages.length === 0 && !loading && thread === null && (
          <div className="text-muted text-sm">
            Nothing here yet. Try: &quot;What needs my attention today?&quot;
          </div>
        )}
        {messages.length > visibleCount && (
          <div className="flex justify-center">
            <button
              onClick={() => setVisibleCount((c) => c + VISIBLE_STEP)}
              data-testid="show-earlier"
              className="text-xs text-muted border border-panel-border rounded px-3 py-1.5 hover:border-gold hover:text-foreground"
            >
              Show {Math.min(VISIBLE_STEP, messages.length - visibleCount)} earlier messages ({messages.length - visibleCount} hidden)
            </button>
          </div>
        )}
        {messages.slice(-visibleCount).map((m, i, shown) => (
          <MessageBubble key={m.id ?? `local-${messages.length - shown.length + i}`} m={m} onReviewSchedule={setReviewScheduleDate} onUndoChanged={stableRefreshCurrent} />
        ))}
        {loading && (
          <div className="flex justify-start">
            <LiveWork thread={keyOf(thread)} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className={`border-t border-panel-border ${dock ? "px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" : "px-4 md:px-8 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]"}`}>
        {fileError && (
          <div role="alert" data-testid="chat-file-error" className="mb-2 text-xs text-red-400">
            {fileError}
          </div>
        )}
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {pendingFiles.map((f, i) => (
              <div
                key={i}
                data-testid="chat-file-chip"
                className="flex items-center gap-2 bg-panel border border-panel-border rounded px-2 py-1 text-xs"
              >
                {f.type.startsWith("image/") && <FileThumb file={f} />}
                <span className="truncate max-w-40">{f.name}</span>
                <span className="text-muted">{formatBytes(f.size)}</span>
                <button
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
                  className="text-muted hover:text-accent"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div data-testid="chat-composer" className="flex flex-col rounded-3xl border border-panel-border bg-panel px-3 pt-3 pb-2 focus-within:border-gold">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            onChange={(e) => {
              // Copy the files out before clearing the input — the state updater runs
              // later, after `value = ""` has already emptied the live FileList.
              const picked = Array.from(e.target.files ?? []);
              if (picked.length) addFiles(picked);
              e.target.value = "";
            }}
          />
          <div className="relative flex min-w-0">
          {mention && (
            <MentionPicker
              query={mention.query}
              active={mentionActive}
              onEntries={(list) => {
                mentionEntries.current = list;
                setMentionActive((a) => (a >= list.length ? 0 : a));
              }}
              onPick={pickMention}
              onHover={setMentionActive}
            />
          )}
          <textarea
            ref={textareaRef}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData?.files ?? []);
              if (pasted.length > 0) {
                e.preventDefault();
                addFiles(pasted);
              }
              const html = e.clipboardData?.getData("text/html") ?? "";
              const plain = e.clipboardData?.getData("text/plain") ?? "";
              const merged = html && plain ? buildPasteText(plain, html) : null;
              if (merged !== null) {
                e.preventDefault();
                const el = e.currentTarget;
                el.focus();
                // execCommand keeps undo and fires onChange (so @mention detection still runs); fall back to state
                if (!document.execCommand("insertText", false, merged)) {
                  const s = el.selectionStart, en = el.selectionEnd;
                  setInput(input.slice(0, s) + merged + input.slice(en));
                }
              }
            }}
            rows={1}
            className="flex-1 min-w-0 resize-none bg-transparent px-1 py-1 text-sm outline-none max-h-60 overflow-y-auto"
            placeholder={
              loading
                ? "Working on your last message… open + New chat to do something else meanwhile"
                : dock
              ? "Ask about this page, or anything…"
              : coarse
              ? "Message Chief…"
              : "Message Chief…  (Shift+Enter for a new line)"
            }
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              detectMention(e.currentTarget);
            }}
            onSelect={(e) => detectMention(e.currentTarget)}
            onKeyDown={(e) => {
              // While the @ picker is open it owns these keys. This runs BEFORE the Enter-to-send
              // branch below and always preventDefaults, so Enter with the picker open can never send.
              if (mention && !e.nativeEvent.isComposing) {
                const list = mentionEntries.current;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  if (list.length) setMentionActive((a) => (e.key === "ArrowDown" ? (a + 1) % list.length : (a - 1 + list.length) % list.length));
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  const pick = list[Math.min(mentionActive, list.length - 1)];
                  if (pick) pickMention(pick);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMention(null);
                  return;
                }
              }
              // Enter sends; Shift+Enter inserts a new line. Ignore Enter while an IME is composing.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                if (coarseRef.current) return; // mobile: default action = newline, never send
                e.preventDefault();
                send();
              }
            }}
          />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Attach a file"
              aria-label="Attach a file"
              data-testid="attach-btn"
              className={`${ICON_BTN} border-panel-border hover:border-gold hover:text-gold`}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-testid="attach-icon">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted">
              <select
                value={model}
                onChange={(e) => pick(MODEL_KEY, e.target.value, setModel)}
                aria-label="Model"
                title="Which model answers your next message"
                data-testid="chat-model"
                className="rounded-full bg-white/5 px-3 py-2 outline-none focus:ring-1 focus:ring-gold min-w-0"
              >
                {CHAT_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <select
                value={model === NO_EFFORT_MODEL ? "" : effort}
                onChange={(e) => pick(EFFORT_KEY, e.target.value, setEffort)}
                disabled={model === NO_EFFORT_MODEL}
                aria-label="Effort"
                title={model === NO_EFFORT_MODEL ? "Haiku has no effort setting" : "How hard it thinks: higher is slower and costs more"}
                data-testid="chat-effort"
                className="rounded-full bg-white/5 px-3 py-2 outline-none focus:ring-1 focus:ring-gold disabled:opacity-50 min-w-0"
              >
                {CHAT_EFFORTS.map((e) => (
                  <option key={e.id} value={e.id}>{e.label}</option>
                ))}
              </select>
            </div>
            {dictation.supported && (
              <button
                type="button"
                onClick={dictation.toggle}
                aria-pressed={dictation.listening}
                aria-label={dictation.listening ? "Stop dictation" : "Start dictation"}
                title={dictation.listening ? "Stop dictation" : "Dictate with your voice"}
                data-testid="dictate-btn"
                className={`${ICON_BTN} ${dictation.listening ? "border-red-500 bg-red-500/20 text-red-400 animate-pulse" : "border-panel-border hover:border-gold hover:text-gold"}`}
              >
                {dictation.listening ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-testid="dictate-icon-stop">
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-testid="dictate-icon-mic">
                    <rect x="9" y="2" width="6" height="12" rx="3" />
                    <path d="M5 11a7 7 0 0 0 14 0" />
                    <line x1="12" y1="18" x2="12" y2="22" />
                    <line x1="8" y1="22" x2="16" y2="22" />
                  </svg>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={send}
              disabled={loading}
              aria-label="Send"
              title="Send"
              data-testid="send-btn"
              className="shrink-0 h-9 w-9 flex items-center justify-center rounded-full bg-gold text-black hover:bg-gold-soft disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
            </button>
          </div>
        </div>
        {dictation.listening && (
          <div className="mt-2 text-xs text-red-400" role="status" aria-live="polite" data-testid="dictate-status">
            ● Listening… speak, then tap the mic to stop. Nothing sends until you press Send.
          </div>
        )}
        {dictation.error && (
          <div className="mt-2 text-xs text-accent" role="alert" data-testid="dictate-error">{dictation.error}</div>
        )}
      </div>

      {reviewScheduleDate && (
        <ScheduleReviewModal date={reviewScheduleDate} onClose={() => setReviewScheduleDate(null)} />
      )}
    </div>
  );
}
