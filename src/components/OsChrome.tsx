"use client";
// Renders the OS chrome (sidebar, chat dock, banners) everywhere except the sign-in page and collaborator pages (/c/<token>/...),
// which must show only The Creation and must never mount anything that talks to the rest of the OS.
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

export function isCollabPathname(p: string | null): boolean {
  return !!p && /^\/c\/[A-Za-z0-9_-]{32}(\/|$)/.test(p);
}

/** The sign-in page stands on its own: no sidebar, chat or banners (they'd call APIs that need a session). */
export function isBarePathname(p: string | null): boolean {
  return isCollabPathname(p) || p === "/login" || !!p?.startsWith("/login/");
}

export default function OsChrome({ children }: { children: ReactNode }) {
  return isBarePathname(usePathname()) ? null : <>{children}</>;
}
