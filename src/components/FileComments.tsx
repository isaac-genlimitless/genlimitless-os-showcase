"use client";

import { useEffect, useRef } from "react";

type Mounted = { destroy: () => void };
type GLComments = { mount: (o: { root: Element; api: string; mode: "owner" | "share"; name?: string; pillHost?: Element }) => Mounted };

declare global {
  interface Window {
    GLComments?: GLComments;
    __glCommentsLoading?: Promise<void>;
  }
}

function loadScript(): Promise<void> {
  if (window.GLComments) return Promise.resolve();
  if (!window.__glCommentsLoading) {
    window.__glCommentsLoading = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/api/files/comments-client";
      s.onload = () => resolve();
      s.onerror = () => {
        window.__glCommentsLoading = undefined;
        reject(new Error("comments script failed"));
      };
      document.head.appendChild(s);
    });
  }
  return window.__glCommentsLoading;
}

// Highlight-to-comment for a Files page. Renders only a placeholder; the shared client script
// builds its own UI and paints highlights without touching the editor DOM. Fails quietly.
export default function FileComments({ pageId }: { pageId: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let mounted: Mounted | null = null;
    loadScript()
      .then(async () => {
        if (cancelled || !window.GLComments) return;
        const root = ref.current?.parentElement?.querySelector('[data-testid="page-editor"]');
        if (!root) return;
        let host: Element | null = null;
        for (let i = 0; i < 20 && !cancelled; i++) {
          host = document.querySelector('[data-testid="file-comments-slot"]');
          if (host) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (cancelled || !window.GLComments) return;
        mounted = window.GLComments.mount({ root, api: `/api/files/${pageId}/comments`, mode: "owner", pillHost: host || undefined });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      mounted?.destroy();
    };
  }, [pageId]);

  return <div ref={ref} data-testid="file-comments-anchor" className="hidden" />;
}
