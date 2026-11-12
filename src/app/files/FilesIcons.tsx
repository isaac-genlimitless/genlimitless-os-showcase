import type { ReactNode } from "react";

export type FIconName =
  | "close" | "plus-page" | "folder-plus" | "upload" | "download" | "share"
  | "star" | "star-fill" | "move" | "trash" | "sparkle";

const STAR = "12 2 15.1 8.6 22 9.3 16.8 14 18.2 21 12 17.5 5.8 21 7.2 14 2 9.3 8.9 8.6";

export function FIcon({ name }: { name: FIconName }) {
  let body: ReactNode;
  switch (name) {
    case "close": body = <path d="M6 6l12 12M18 6L6 18" />; break;
    case "plus-page": body = <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14h6" />; break;
    case "folder-plus": body = <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6" />; break;
    case "upload": body = <path d="M12 15V3m0 0L8 7m4-4l4 4M4 21h16" />; break;
    case "download": body = <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />; break;
    case "share": body = <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13" />; break;
    case "star": body = <polygon points={STAR} />; break;
    case "star-fill": body = <polygon points={STAR} fill="currentColor" />; break;
    case "move": body = <path d="M5 12h14m0 0l-5-5m5 5l-5 5" />; break;
    case "trash": body = <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />; break;
    case "sparkle": body = <path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" />; break;
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {body}
    </svg>
  );
}
