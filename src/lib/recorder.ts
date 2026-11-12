"use client";

import { useSyncExternalStore } from "react";

// The meeting recorder, kept outside React so a recording keeps going while Owner moves around
// the OS (take notes in Files, check the calendar) — only closing or reloading the tab stops it.
//
// Audio: the mic, optionally mixed with a shared browser tab / screen's audio (a Meet or Zoom
// web call), recorded with MediaRecorder and streamed to the server in 10-second chunks.
// Live transcript: the browser's speech recognition on the mic, shown as it goes and used as
// the transcript when no server transcription engine is configured.

export type RecorderState = {
  status: "idle" | "starting" | "recording" | "stopping";
  meetingId: number | null;
  title: string;
  startedAt: number | null;
  level: number; // 0..1 input level, for the meter
  transcript: string; // finalized lines
  interim: string;
  liveSupported: boolean;
  capturingTab: boolean;
  error: string | null;
  lastFinishedId: number | null;
};

let state: RecorderState = {
  status: "idle",
  meetingId: null,
  title: "",
  startedAt: null,
  level: 0,
  transcript: "",
  interim: "",
  liveSupported: true,
  capturingTab: false,
  error: null,
  lastFinishedId: null,
};
const listeners = new Set<() => void>();
function set(patch: Partial<RecorderState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useRecorder(): RecorderState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state
  );
}

// ---------------------------------------------------------------- internals

let recorder: MediaRecorder | null = null;
let streams: MediaStream[] = [];
let audioCtx: AudioContext | null = null;
let recognition: any = null;
let uploadChain: Promise<unknown> = Promise.resolve();
let meterTimer: ReturnType<typeof setInterval> | null = null;
let saveTimer: ReturnType<typeof setInterval> | null = null;

const stamp = () => {
  const s = Math.floor((Date.now() - (state.startedAt || Date.now())) / 1000);
  return `[${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}]`;
};

function startRecognition() {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) {
    set({ liveSupported: false });
    return;
  }
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";
  recognition.onresult = (e: any) => {
    let interim = "";
    let finals = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finals += r[0].transcript.trim() + " ";
      else interim += r[0].transcript;
    }
    if (finals.trim()) set({ transcript: `${state.transcript}${stamp()} ${finals.trim()}\n` });
    set({ interim });
  };
  // Browsers end recognition after a pause or ~a minute; keep it going for the whole meeting.
  recognition.onend = () => {
    if (state.status === "recording") {
      try {
        recognition.start();
      } catch {
        /* already restarting */
      }
    }
  };
  recognition.onerror = (e: any) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") set({ liveSupported: false });
  };
  try {
    recognition.start();
  } catch {
    set({ liveSupported: false });
  }
}

function pickMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function cleanup() {
  if (meterTimer) clearInterval(meterTimer);
  if (saveTimer) clearInterval(saveTimer);
  meterTimer = saveTimer = null;
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  streams = [];
  audioCtx?.close().catch(() => {});
  audioCtx = null;
  try {
    recognition?.stop();
  } catch {
    /* not running */
  }
  recognition = null;
  recorder = null;
  window.removeEventListener("beforeunload", warnUnload);
}

function warnUnload(e: BeforeUnloadEvent) {
  e.preventDefault();
  e.returnValue = "";
}

// ---------------------------------------------------------------- public API

export async function startRecording(opts: { title?: string; includeTab?: boolean; event?: { id: string; account: string; attendees: string[] } | null }) {
  if (state.status !== "idle") return;
  set({ status: "starting", error: null, transcript: "", interim: "", level: 0, title: opts.title || "", capturingTab: false, liveSupported: true });
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    streams.push(mic);
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    const micSrc = audioCtx.createMediaStreamSource(mic);
    micSrc.connect(dest);
    micSrc.connect(analyser);

    if (opts.includeTab) {
      try {
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        streams.push(screen);
        const tabAudio = screen.getAudioTracks();
        if (tabAudio.length) {
          const src = audioCtx.createMediaStreamSource(new MediaStream(tabAudio));
          src.connect(dest);
          src.connect(analyser);
          set({ capturingTab: true });
        }
        screen.getVideoTracks().forEach((t) => t.stop()); // audio only
      } catch {
        /* Owner cancelled the share: record the mic only */
      }
    }

    const mimeType = pickMime();
    const res = await fetch("/api/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: opts.title,
        mime: mimeType || "audio/webm",
        event_id: opts.event?.id,
        event_account: opts.event?.account,
        attendees: opts.event?.attendees,
      }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "Couldn't start the meeting");
    const id: number = d.meeting.id;

    recorder = new MediaRecorder(dest.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 48_000 });
    uploadChain = Promise.resolve();
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      const chunk = e.data;
      // Sequential, so chunks land in order.
      uploadChain = uploadChain.then(() =>
        fetch(`/api/meetings/${id}/audio`, { method: "POST", body: chunk }).catch(() => set({ error: "A chunk of audio failed to upload; the live transcript is still being kept." }))
      );
    };
    recorder.start(10_000);

    const buf = new Uint8Array(analyser.frequencyBinCount);
    meterTimer = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
      set({ level: Math.min(1, peak * 1.6) });
    }, 120);
    saveTimer = setInterval(() => {
      fetch(`/api/meetings/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ live_transcript: state.transcript }) }).catch(() => {});
    }, 15_000);

    window.addEventListener("beforeunload", warnUnload);
    set({ status: "recording", meetingId: id, title: d.meeting.title, startedAt: Date.now() });
    startRecognition();
  } catch (err: any) {
    cleanup();
    set({
      status: "idle",
      error: err?.name === "NotAllowedError" ? "Microphone access was blocked. Allow it in the browser's site settings and try again." : err?.message || String(err),
    });
  }
}

export async function stopRecording() {
  if (state.status !== "recording" || !recorder) return;
  const id = state.meetingId!;
  set({ status: "stopping" });
  const rec = recorder;
  const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  rec.stop();
  await stopped;
  await uploadChain;
  const transcript = state.transcript + (state.interim ? `${stamp()} ${state.interim}\n` : "");
  cleanup();
  await fetch(`/api/meetings/${id}/finish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ live_transcript: transcript }) }).catch(() => {});
  set({ status: "idle", meetingId: null, startedAt: null, level: 0, interim: "", lastFinishedId: id });
  return id;
}

/** The "recording saved" notice has been seen. */
export function ackFinished() {
  set({ lastFinishedId: null });
}

export function renameRecording(title: string) {
  set({ title });
  if (state.meetingId) {
    fetch(`/api/meetings/${state.meetingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) }).catch(() => {});
  }
}
