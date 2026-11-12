"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { ackFinished, renameRecording, startRecording, stopRecording, useRecorder } from "@/lib/recorder";
import { setOsContext } from "@/lib/os-context";

// Meetings: record a meeting (mic, plus a browser tab's audio for web calls), watch the live
// transcript, and get Chief of Staff notes with action items, filed into Files automatically.

type ActionItem = { task: string; owner?: string; due?: string };
type MeetingRow = {
  id: number;
  title: string;
  status: "recording" | "processing" | "ready" | "failed";
  page_id: number | null;
  started_at: string;
  duration_sec: number | null;
  action_items: ActionItem[];
  error: string | null;
  url: string | null;
};
type MeetingFull = MeetingRow & { transcript: string | null; live_transcript: string; notes: string | null; transcript_source: string | null; has_audio: boolean; attendees: string[] };
type Engine = "openai" | "local" | "browser";
type CalEvent = { id: string; account: string; summary: string; start: string; end: string; attendees: string[] };

const REMARK = [remarkGfm];
const REHYPE = [rehypeSanitize];

function when(sqlite: string) {
  return new Date(sqlite.replace(" ", "T") + "Z").toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export default function MeetingsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted">Loading…</div>}>
      <MeetingsInner />
    </Suspense>
  );
}

function MeetingsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = params.get("id") ? Number(params.get("id")) : null;
  const rec = useRecorder();

  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [selected, setSelected] = useState<MeetingFull | null>(null);
  const [title, setTitle] = useState(params.get("title") || "");
  const [includeTab, setIncludeTab] = useState(false);
  const [event, setEvent] = useState<CalEvent | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const d = await fetch("/api/meetings").then((r) => r.json());
    setMeetings(d.meetings || []);
    setEngine(d.engine);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Title the recording after the calendar event happening now (or the one passed from Calendar).
  useEffect(() => {
    const evId = params.get("event");
    if (evId) {
      setEvent({ id: evId, account: params.get("account") || "", summary: params.get("title") || "", start: "", end: "", attendees: (params.get("attendees") || "").split(",").filter(Boolean) });
      return;
    }
    fetch("/api/calendar?now=1")
      .then((r) => r.json())
      .then((d) => {
        if (d.event) {
          setEvent(d.event);
          setTitle((t) => t || d.event.summary);
        }
      })
      .catch(() => {});
  }, [params]);

  const loadSelected = useCallback(async (id: number) => {
    const res = await fetch(`/api/meetings/${id}`);
    if (res.ok) setSelected((await res.json()).meeting);
  }, []);

  useEffect(() => {
    if (selectedId) loadSelected(selectedId);
    else setSelected(null);
  }, [selectedId, loadSelected]);

  // Follow processing until the notes are ready.
  const processing = meetings.some((m) => m.status === "processing") || selected?.status === "processing";
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => {
      load();
      if (selectedId) loadSelected(selectedId);
    }, 4000);
    return () => clearInterval(t);
  }, [processing, load, loadSelected, selectedId]);

  useEffect(() => {
    // Jump to a recording once it's saved.
    if (rec.lastFinishedId) {
      const id = rec.lastFinishedId;
      ackFinished();
      load();
      router.push(`/meetings?id=${id}`);
    }
  }, [rec.lastFinishedId, load, router]);

  useEffect(() => {
    if (rec.status !== "recording") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [rec.status]);

  useEffect(() => {
    setOsContext(
      rec.status === "recording"
        ? `Meetings: recording "${rec.title}" right now`
        : selected
        ? `Meetings: "${selected.title}" (meeting_id ${selected.id}${selected.page_id ? `, notes page_id ${selected.page_id}` : ""})`
        : "the Meetings screen"
    );
    return () => setOsContext(null);
  }, [selected, rec.status, rec.title]);

  const transcriptEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: "nearest" });
  }, [rec.transcript, rec.interim]);

  async function importFile(file: File) {
    setImporting(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/meetings", { method: "POST", body: form });
      const d = await res.json();
      if (!res.ok) return alert(d.error);
      await load();
      router.push(`/meetings?id=${d.meeting.id}`);
    } finally {
      setImporting(false);
    }
  }

  async function retry(id: number) {
    const res = await fetch(`/api/meetings/${id}/retry`, { method: "POST" });
    const d = await res.json();
    if (!res.ok) return alert(d.error);
    await load();
    loadSelected(id);
  }

  const recording = rec.status === "recording" || rec.status === "stopping";
  const secs = rec.startedAt ? Math.max(0, Math.floor((now - rec.startedAt) / 1000)) : 0;

  return (
    <div className="h-full flex flex-col md:flex-row">
      {/* list */}
      <div className="w-full md:w-72 shrink-0 max-h-[35dvh] md:max-h-none border-b md:border-b-0 md:border-r border-panel-border flex flex-col">
        <div className="px-4 pt-6 pb-3 border-b border-panel-border flex items-center justify-between">
          <Link href="/meetings" className="font-display text-2xl tracking-wide hover:text-accent">Meetings</Link>
          {engine && engine !== "browser" && (
            <button onClick={() => fileRef.current?.click()} disabled={importing} className="text-xs border border-panel-border rounded px-2.5 py-1.5 hover:border-gold disabled:opacity-50" title="Transcribe an existing recording">
              {importing ? "Uploading…" : "Upload audio"}
            </button>
          )}
          <input ref={fileRef} type="file" accept="audio/*,video/*" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) importFile(f); }} />
        </div>
        <div className="flex-1 overflow-y-auto">
          {meetings.length === 0 && <div className="p-4 text-sm text-muted">No meetings recorded yet.</div>}
          {meetings.map((m) => (
            <button
              key={m.id}
              onClick={() => router.push(`/meetings?id=${m.id}`)}
              className={`w-full text-left px-4 py-3 border-b border-panel-border/60 ${selectedId === m.id ? "bg-wash-3" : "hover:bg-wash-1"}`}
            >
              <div className="text-sm font-medium truncate">{m.title}</div>
              <div className="text-xs text-muted mt-1 flex items-center gap-2">
                <span>{when(m.started_at)}</span>
                {m.duration_sec ? <span>{Math.round(m.duration_sec / 60)} min</span> : null}
                <StatusBadge status={m.status} />
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* main */}
      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 md:px-10 py-6 md:py-8 space-y-8">
          {/* recorder */}
          <section className={`border rounded-xl p-5 ${recording ? "border-danger/50 bg-danger/10" : "border-panel-border bg-panel/50"}`} data-testid="recorder">
            {!recording ? (
              <>
                <div className="flex items-center gap-3">
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="What's this meeting? (optional)"
                    className="flex-1 bg-background border border-panel-border rounded-lg px-3 py-2 text-sm outline-none focus:border-gold"
                  />
                  <button
                    onClick={() => startRecording({ title: title.trim() || event?.summary, includeTab, event: event?.id ? { id: event.id, account: event.account, attendees: event.attendees } : null })}
                    disabled={rec.status === "starting"}
                    className="bg-red-500 text-white font-semibold text-sm rounded-lg px-4 py-2 hover:bg-red-600 disabled:opacity-60 flex items-center gap-2"
                  >
                    <span className="w-2.5 h-2.5 rounded-full bg-white" />
                    {rec.status === "starting" ? "Starting…" : "Start recording"}
                  </button>
                </div>
                {event?.summary && (
                  <div className="text-xs text-muted mt-2">
                    📅 Linked to <b className="text-foreground/80">{event.summary}</b>
                    {event.attendees.length ? ` with ${event.attendees.slice(0, 4).join(", ")}` : ""}
                  </div>
                )}
                <label className="flex items-start gap-2 text-xs text-muted mt-3 cursor-pointer">
                  <input type="checkbox" checked={includeTab} onChange={(e) => setIncludeTab(e.target.checked)} className="mt-0.5" />
                  <span>
                    Also capture a browser tab&apos;s audio (Google Meet / Zoom in the browser). You&apos;ll pick the tab and tick &quot;Share tab audio&quot;.
                    For a call in a desktop app, use speakers rather than headphones so the mic hears both sides.
                  </span>
                </label>
                <div className="text-xs text-muted mt-3">
                  Transcription:{" "}
                  {engine === "openai" ? (
                    <span className="text-success">Whisper (full audio, every voice)</span>
                  ) : engine === "local" ? (
                    <span className="text-success">local Whisper (offline, every voice)</span>
                  ) : (
                    <span>
                      live browser speech recognition (hears your mic). For a full-audio transcript of every voice, add <code>OPENAI_API_KEY</code> to <code>.env.local</code>, or install whisper-cpp and set <code>WHISPER_MODEL</code>.
                    </span>
                  )}
                </div>
                {rec.error && <div className="text-xs text-danger mt-3">{rec.error}</div>}
              </>
            ) : (
              <>
                <div className="flex items-center gap-4">
                  <span className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
                  <input
                    value={rec.title}
                    onChange={(e) => renameRecording(e.target.value)}
                    className="flex-1 bg-transparent text-lg font-semibold outline-none"
                    aria-label="Meeting title"
                  />
                  <span className="font-mono text-sm">{clock(secs)}</span>
                  <button onClick={() => stopRecording()} disabled={rec.status === "stopping"} className="bg-foreground text-background font-semibold text-sm rounded-lg px-4 py-2 hover:opacity-90 disabled:opacity-60">
                    {rec.status === "stopping" ? "Saving…" : "Stop & write notes"}
                  </button>
                </div>
                <div className="h-1.5 bg-wash-3 rounded mt-3 overflow-hidden">
                  <div className="h-full bg-red-500 transition-[width] duration-100" style={{ width: `${Math.round(rec.level * 100)}%` }} />
                </div>
                <div className="text-[11px] text-muted mt-2">
                  {rec.capturingTab ? "Recording your mic + the shared tab. " : "Recording your mic. "}
                  You can switch to other tabs of the OS (take notes in Files); it keeps recording until you stop.
                </div>
                <div className="mt-4 max-h-72 overflow-y-auto bg-wash-2 rounded-lg p-3 text-sm whitespace-pre-wrap font-light leading-relaxed">
                  {rec.transcript || rec.interim ? (
                    <>
                      {rec.transcript}
                      <span className="text-muted">{rec.interim}</span>
                    </>
                  ) : (
                    <span className="text-muted">{rec.liveSupported ? "Listening… the live transcript appears here." : "Live transcript isn't available in this browser (use Chrome or Safari); the audio is still being recorded."}</span>
                  )}
                  <div ref={transcriptEnd} />
                </div>
                {rec.error && <div className="text-xs text-danger mt-2">{rec.error}</div>}
              </>
            )}
          </section>

          {/* selected meeting */}
          {selected && <MeetingDetail m={selected} onRetry={() => retry(selected.id)} />}
          {!selected && !recording && meetings.length > 0 && <div className="text-sm text-muted">Pick a meeting on the left to see its notes.</div>}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: MeetingRow["status"] }) {
  const cls =
    status === "ready" ? "border-success/50 text-success" : status === "failed" ? "border-danger/50 text-danger" : status === "processing" ? "border-gold text-accent" : "border-danger/50 text-danger";
  const label = status === "processing" ? "writing notes…" : status;
  return <span className={`text-[10px] border rounded px-1.5 py-0.5 ${cls}`}>{label}</span>;
}

function MeetingDetail({ m, onRetry }: { m: MeetingFull; onRetry: () => void }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const transcript = m.transcript || m.live_transcript;
  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{m.title}</h1>
          <div className="text-xs text-muted mt-1 flex flex-wrap gap-3 items-center">
            <span>{when(m.started_at)}</span>
            {m.duration_sec ? <span>{Math.round(m.duration_sec / 60)} min</span> : null}
            <StatusBadge status={m.status} />
            {m.attendees.length > 0 && <span>with {m.attendees.join(", ")}</span>}
          </div>
        </div>
        {m.url && (
          <Link href={m.url} className="shrink-0 text-xs border border-panel-border rounded px-3 py-1.5 hover:border-gold">
            Open notes in Files →
          </Link>
        )}
      </div>
      {m.has_audio && (
        <audio controls preload="none" src={`/api/meetings/${m.id}/audio`} className="w-full" />
      )}
      {m.status === "processing" && <div className="text-sm text-accent">Transcribing and writing notes… this page updates by itself.</div>}
      {m.status === "failed" && (
        <div className="border border-danger/50 rounded-lg p-3 text-sm">
          <div className="text-danger">{m.error}</div>
          <button onClick={onRetry} className="mt-2 text-xs border border-panel-border rounded px-3 py-1.5 hover:border-gold">Retry</button>
        </div>
      )}
      {m.notes && (
        <div className="markdown-body text-sm border border-panel-border rounded-lg p-5 bg-panel/40">
          <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE}>{m.notes}</ReactMarkdown>
        </div>
      )}
      {transcript && (
        <div>
          <button onClick={() => setShowTranscript((s) => !s)} className="text-xs text-muted hover:text-foreground">
            {showTranscript ? "▾" : "▸"} Transcript {m.transcript_source ? `(${m.transcript_source === "browser" ? "live" : "Whisper"})` : ""}
          </button>
          {showTranscript && <pre className="mt-2 text-xs whitespace-pre-wrap bg-panel border border-panel-border rounded-lg p-4 max-h-[60vh] overflow-y-auto font-sans">{transcript}</pre>}
        </div>
      )}
      {m.status === "ready" && m.page_id && (
        <div className="text-xs text-muted">Ask Chief (⌘J) to draft the follow-up, schedule the next step, or add these action items to a project page.</div>
      )}
    </section>
  );
}
