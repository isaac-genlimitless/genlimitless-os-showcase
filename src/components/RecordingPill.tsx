"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ackFinished, stopRecording, useRecorder } from "@/lib/recorder";

// Shown on every screen while a meeting is being recorded, so Owner can take notes anywhere in
// the OS and still see (and stop) the recording.
export default function RecordingPill() {
  const r = useRecorder();
  const pathname = usePathname();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (r.status !== "recording") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [r.status]);

  if (pathname === "/meetings") return null;
  if (r.status === "idle" && r.lastFinishedId) {
    return (
      <div className="fixed top-16 right-3 md:top-4 md:right-5 max-w-[calc(100vw-1.5rem)] z-50 flex items-center gap-3 bg-panel border border-panel-border rounded-full pl-4 pr-2 py-1.5 shadow-lg shadow-black/50 text-xs">
        <span>✓ Recording saved. Writing notes…</span>
        <Link href={`/meetings?id=${r.lastFinishedId}`} onClick={ackFinished} className="text-accent hover:underline">View</Link>
        <button onClick={ackFinished} aria-label="Dismiss" className="text-muted hover:text-foreground px-1">✕</button>
      </div>
    );
  }
  if (r.status === "idle" || r.status === "starting") return null;
  const secs = r.startedAt ? Math.max(0, Math.floor((now - r.startedAt) / 1000)) : 0;
  return (
    <div className="fixed top-16 right-3 md:top-4 md:right-5 max-w-[calc(100vw-1.5rem)] z-50 flex items-center gap-3 bg-panel border border-danger/50 rounded-full pl-3 pr-2 py-1.5 shadow-lg shadow-black/50 text-xs">
      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
      <Link href="/meetings" className="hover-pill max-w-48 truncate">
        {r.status === "stopping" ? "Saving recording…" : `${r.title || "Recording"} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`}
      </Link>
      {r.status === "recording" && (
        <button onClick={() => stopRecording()} className="bg-red-500/90 text-white rounded-full px-2.5 py-0.5 hover:bg-red-500">
          Stop
        </button>
      )}
    </div>
  );
}
