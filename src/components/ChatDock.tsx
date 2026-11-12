"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { useFocusMode } from "@/lib/focus-mode";

const ChatPanel = dynamic(() => import("./ChatPanel"), { ssr: false });

// The Chief of Staff, one keystroke away on every screen: a resizable sidebar on the right
// (⌘J / Ctrl+J, or the button). Not shown on / (that is the full chat). Open/width are
// remembered per browser.

const KEY = "os.chatDock";
const MIN_W = 320;
const MAX_W = 760;

function isMobile(): boolean {
  try {
    return !window.matchMedia("(min-width: 768px)").matches;
  } catch {
    return false;
  }
}

function load(): { open: boolean; width: number } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { open: !!v.open, width: Math.min(MAX_W, Math.max(MIN_W, Number(v.width) || 420)) };
  } catch {
    return { open: false, width: 420 };
  }
}

export default function ChatDock() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(420);
  const [ready, setReady] = useState(false);
  const dragging = useRef(false);
  const focus = useFocusMode();
  const [focusOpen, setFocusOpen] = useState(false);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(() => {
    if (!focus) setFocusOpen(false);
  }, [focus]);

  useEffect(() => {
    const s = load();
    setOpen(isMobile() ? false : s.open);
    setWidth(s.width);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(KEY, JSON.stringify({ open: isMobile() ? false : open, width }));
    } catch {
      /* private mode: just don't remember */
    }
  }, [open, width, ready]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        if (focusRef.current) setFocusOpen((o) => !o);
        else setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      setWidth(Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX)));
    };
    const up = () => {
      dragging.current = false;
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  if (pathname === "/" || !ready) return null;
  const overlay = focus && focusOpen; // chat drawer shown over the full-screen editor
  const showPanel = focus ? focusOpen : open;
  const mounted = open || focusOpen; // stays mounted (hidden) in focus mode so a chat in progress isn't lost
  const button = !showPanel && (
    <button
      onClick={() => (focus ? setFocusOpen(true) : setOpen(true))}
      data-testid="chat-dock-open"
      title="Ask Chief (⌘J)"
      className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 md:bottom-5 md:right-5 z-40 bg-gold text-black font-semibold text-sm rounded-full pl-4 pr-5 py-3 shadow-lg shadow-black/50 hover:bg-gold-soft flex items-center gap-2"
    >
      <span aria-hidden>✦</span> Ask Chief
    </button>
  );
  if (!mounted) return button || null;

  return (
    <>
      {button}
      <aside
        data-testid="chat-dock"
        style={{ width, maxWidth: "100vw" }}
        className={`chat-dock border-l border-panel-border bg-background ${showPanel ? "flex flex-col" : "hidden"} ${overlay ? "fixed right-0 top-0 z-[60] h-dvh shadow-2xl shadow-black/60" : "relative shrink-0"}`}
      >
        <div
          onMouseDown={() => {
            dragging.current = true;
            document.body.style.userSelect = "none";
          }}
          className="hidden md:block absolute left-0 top-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-gold/40 z-10"
          title="Drag to resize"
        />
        <ChatPanel variant="dock" onClose={() => (focus ? setFocusOpen(false) : setOpen(false))} />
      </aside>
    </>
  );
}
