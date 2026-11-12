"use client";

// What Owner is looking at right now, sent with each chat message so "summarize this" or "add a
// task here" works without him saying which page. The baseline (screen + tab) is computed from the
// URL at send time, so it is right on every screen and can never be stale. Screens add optional
// detail (title/id/url only, never body text) in keyed slots so a child's cleanup can't wipe its parent.

const slots = new Map<string, string>();

export function setOsContext(ctx: string | null, key = "page") {
  if (ctx === null || ctx === undefined || ctx === "") slots.delete(key);
  else slots.set(key, ctx);
}

const SCREENS: Record<string, string> = {
  "/": "Chat home (main chat)",
  "/files": "Files",
  "/calendar": "Calendar",
  "/tasks": "Tasks",
  "/meetings": "Meetings",
  "/team": "Team",
  "/activity": "Activity",
  "/communications": "Communications",
  "/analytics": "Settings",
  "/settings": "Settings",
  "/research": "Research",
  "/software-dev": "Software dev",
};

function baseline(): string {
  if (typeof window === "undefined") return "";
  const { pathname, search } = window.location;
  const norm = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const label = SCREENS[norm] ?? norm;
  const tab = new URLSearchParams(search).get("tab");
  const url = `${pathname}${search}`;
  return tab && norm !== "/" ? `${label} → ${tab} tab (${url})` : `${label} (${url})`;
}

/** Visible text of the current screen (everything in <main>, including open editors), sent with each
 *  chat message and stashed server-side (not put in the prompt); Chief pulls it with read_current_screen. Skipped on the main chat page, where it would just
 *  be the conversation itself. Capped; the server treats it as untrusted data. */
export const SCREEN_TEXT_MAX = 60000;
export function getScreenText(): string {
  if (typeof window === "undefined") return "";
  if (window.location.pathname === "/") return "";
  const main = document.querySelector("main") as HTMLElement | null;
  const text = (main?.innerText || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.slice(0, SCREEN_TEXT_MAX);
}

export function getOsContext(): string {
  const parts = [baseline(), ...Array.from(slots.values()).map((v) => v.slice(0, 200))].filter(Boolean);
  return parts.join("; ").slice(0, 500);
}
