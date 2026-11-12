"use client";
// Pull-to-refresh for phones (installed iPhone app + mobile browser). <main> is the page's only scroller (layout.tsx),
// so the browser never offers its own. Pull down hard from the very top of any screen and the app reloads.
// Additive only: passive listeners, never preventDefault, no network calls except cache clearing.
import { useEffect, useRef } from "react";

const THRESHOLD = 80; // px of finger travel needed before release triggers a refresh
const MAX_SHOWN = 60; // px the indicator slides down at most

function draftInProgress(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || a.isContentEditable)) return true;
  const t = document.querySelectorAll("textarea");
  for (let i = 0; i < t.length; i++) if ((t[i] as HTMLTextAreaElement).value) return true;
  return false;
}

/** True only when a downward pull here should mean "refresh" rather than "scroll something". */
function pullAllowed(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (window.scrollY > 0) return false;
  const main = document.querySelector("main");
  if (main && main.scrollTop > 0) return false;
  if (target.closest('[role="dialog"],[aria-modal="true"],[data-no-ptr],input,textarea,select,[contenteditable=""],[contenteditable="true"]')) return false;
  if (draftInProgress()) return false;
  for (let n: Element | null = target; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const scrolls = /(auto|scroll|overlay)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1;
    if (scrolls && !(n === main && n.scrollTop <= 0)) return false; // an inner list/chat scrolls first
  }
  return true;
}

async function clearStaleCaches() {
  try {
    if (!navigator.onLine) return; // offline: keep the saved copy of the page
    navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
    if (!("caches" in window)) return;
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("glos-")).map((k) => caches.delete(k)));
  } catch { /* a cache hiccup must never block the refresh */ }
}

export default function PullToRefresh() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = ref.current;
    const spin = box?.firstElementChild as HTMLElement | null;
    if (!box || !spin) return;
    let active = false, refreshing = false, startX = 0, startY = 0, pull = 0;

    const draw = (dy: number) => {
      const shown = Math.min(dy * 0.5, MAX_SHOWN);
      box.style.opacity = dy > 0 ? String(Math.min(1, dy / 40)) : "0";
      box.style.transform = `translate(-50%, ${shown - 40}px)`;
      box.dataset.ready = dy >= THRESHOLD ? "1" : "0";
      spin.style.transform = `rotate(${dy * 3}deg)`;
    };
    const reset = () => { active = false; pull = 0; if (!refreshing) draw(0); };

    const onStart = (e: TouchEvent) => {
      if (refreshing) return;
      active = e.touches.length === 1 && pullAllowed(e.target);
      pull = 0;
      if (active) { startX = e.touches[0].clientX; startY = e.touches[0].clientY; }
    };
    const onMove = (e: TouchEvent) => {
      if (!active || refreshing) return;
      if (e.touches.length !== 1 || window.scrollY > 0 || (document.querySelector("main")?.scrollTop ?? 0) > 0) return reset();
      const dy = e.touches[0].clientY - startY;
      const dx = Math.abs(e.touches[0].clientX - startX);
      if (pull === 0 && dx > Math.abs(dy)) { active = false; return; } // sideways swipe
      pull = Math.max(0, dy);
      draw(pull);
    };
    const onEnd = async () => {
      const go = active && pull >= THRESHOLD && !refreshing;
      if (!go) return reset();
      refreshing = true;
      box.dataset.ready = "1";
      box.style.opacity = "1";
      box.style.transform = "translate(-50%, 12px)";
      spin.style.transform = "";
      spin.classList.add("animate-spin");
      await Promise.race([clearStaleCaches(), new Promise((r) => setTimeout(r, 1500))]);
      location.reload();
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", reset);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="ptr-indicator"
      style={{
        position: "fixed", top: "calc(env(safe-area-inset-top, 0px) + 8px)", left: "50%", zIndex: 60,
        width: 32, height: 32, borderRadius: "50%", pointerEvents: "none", opacity: 0,
        transform: "translate(-50%, -40px)", transition: "opacity 0.15s ease",
        background: "var(--background)", border: "1px solid rgba(128,128,128,0.4)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid var(--accent)", borderTopColor: "transparent" }} />
    </div>
  );
}
