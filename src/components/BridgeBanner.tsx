"use client";
import { useEffect, useRef, useState } from "react";

type Status = { applicable: boolean; online: boolean; offlineSince: string | null };

function fmt(mins: number): string {
  if (mins < 1) return "<1 min";
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export default function BridgeBanner() {
  const [s, setS] = useState<Status | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [recovered, setRecovered] = useState(false);
  const wasOffline = useRef(false);
  const recoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/bridge-status", { cache: "no-store" })
        .then((r) => r.json())
        .then((j: Status) => {
          if (!alive) return;
          setS(j);
          setNow(Date.now());
          if (wasOffline.current && j.applicable && j.online) {
            setRecovered(true);
            if (recoverTimer.current) clearTimeout(recoverTimer.current);
            recoverTimer.current = setTimeout(() => setRecovered(false), 6000);
          }
          wasOffline.current = !!(j.applicable && !j.online);
        })
        .catch(() => {});
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    load();
    const t = setInterval(load, 15_000);
    const c = setInterval(() => setNow(Date.now()), 30_000);
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(c);
      if (recoverTimer.current) clearTimeout(recoverTimer.current);
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (recovered) {
    return (
      <div data-testid="bridge-banner-recovered" role="status" className="bg-green-600 text-white text-xs text-center py-1 px-2 shrink-0">
        Mac bridge back online
      </div>
    );
  }
  if (!s || !s.applicable || s.online) return null;
  const since = s.offlineSince
    ? new Date(s.offlineSince).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }) + " CT"
    : "an unknown time";
  const mins = s.offlineSince ? Math.max(0, Math.floor((now - new Date(s.offlineSince).getTime()) / 60_000)) : null;
  return (
    <div data-testid="bridge-banner" role="status" className="bg-amber-500 text-black text-xs text-center py-1 px-2 shrink-0">
      Mac bridge offline since {since}
      {mins !== null ? ` (offline for ${fmt(mins)})` : ""} — iMessage sending and new texts are paused
    </div>
  );
}
