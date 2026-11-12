"use client";
// Persistent "Viewing as X · Exit" bar. Fails quiet: any endpoint error means no banner.
import { useCallback, useEffect, useRef, useState } from "react";

type State = { name: string; expiresAt: number };

export default function ImpersonationBanner() {
  const [st, setSt] = useState<State | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const barRef = useRef<HTMLDivElement>(null);
  const stopping = useRef(false);

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/impersonate", { cache: "no-store" });
      if (!r.ok) return setSt(null);
      const j = await r.json();
      if (j && j.active) {
        const exp = typeof j.expiresAt === "number" ? j.expiresAt : Date.parse(j.expiresAt);
        const left = typeof j.secondsLeft === "number" ? j.secondsLeft * 1000 : NaN;
        setSt({ name: String(j.name ?? j.user?.name ?? "user"), expiresAt: Number.isFinite(exp) ? exp : Date.now() + (Number.isFinite(left) ? left : 0) });
        setNow(Date.now());
      } else setSt(null);
    } catch {
      /* quiet */
    }
  }, []);

  const stop = useCallback(async () => {
    if (stopping.current) return;
    stopping.current = true;
    try {
      await fetch("/api/auth/impersonate", { method: "DELETE" });
    } catch {
      /* quiet */
    }
    window.location.assign("/");
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 30000);
    return () => clearInterval(id);
  }, [poll]);

  useEffect(() => {
    if (!st) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [st]);

  const leftSec = st ? Math.max(0, Math.ceil((st.expiresAt - now) / 1000)) : 0;
  useEffect(() => {
    if (st && leftSec <= 0) stop();
  }, [st, leftSec, stop]);

  // Push page content down by the bar's height so it never covers the sidebar button.
  useEffect(() => {
    const root = document.documentElement;
    if (!st || !barRef.current) {
      root.style.setProperty("--impersonation-h", "0px");
      return;
    }
    const el = barRef.current;
    const set = () => root.style.setProperty("--impersonation-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.setProperty("--impersonation-h", "0px");
    };
  }, [st]);

  if (!st) return null;
  const mm = Math.floor(leftSec / 60);
  const ss = String(leftSec % 60).padStart(2, "0");
  return (
    <>
      <style>{`body{padding-top:var(--impersonation-h,0px)} body > div.relative{} .imp-bar{z-index:2147483000}`}</style>
      <div
        ref={barRef}
        role="status"
        data-testid="impersonation-banner"
        className="imp-bar fixed top-0 left-0 right-0 w-full bg-amber-400 text-black px-3 py-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm font-semibold"
      >
        <span className="min-w-0 break-words">
          Viewing as {st.name} · read-only, changes are blocked · <span data-testid="impersonation-countdown">{mm}:{ss}</span> left
        </span>
        <button type="button" onClick={stop} className="min-h-[44px] px-4 rounded-md bg-black text-amber-300 font-bold">
          Exit
        </button>
      </div>
    </>
  );
}
