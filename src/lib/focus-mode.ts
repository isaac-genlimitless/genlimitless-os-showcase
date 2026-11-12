"use client";

import { useSyncExternalStore } from "react";

// Full-screen (focus) mode flag shared between the Files page and the app shell (nav, chat dock).
// Stored as <html data-focus-mode>; no data is touched.
const ATTR = "data-focus-mode";
const EVT = "os-focus-mode";

export function isFocusMode(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute(ATTR);
}

export function setFocusMode(on: boolean) {
  if (typeof document === "undefined") return;
  if (on) document.documentElement.setAttribute(ATTR, "1");
  else document.documentElement.removeAttribute(ATTR);
  window.dispatchEvent(new Event(EVT));
}

function subscribe(cb: () => void) {
  window.addEventListener(EVT, cb);
  return () => window.removeEventListener(EVT, cb);
}

export function useFocusMode(): boolean {
  return useSyncExternalStore(subscribe, isFocusMode, () => false);
}
