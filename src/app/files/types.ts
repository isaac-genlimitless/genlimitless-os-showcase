export type Kind = "page" | "folder" | "file" | "meeting";

export type TreeNode = {
  id: number;
  title: string;
  kind: Kind;
  icon: string | null;
  parent_id: number | null;
  favorite: 0 | 1;
  sort_order: number;
  updated_at: string;
  created_by: "owner" | "agent";
  mime_type: string | null;
  placed_by: "owner" | "ai" | null;
};

export type Child = TreeNode & { tags: string[]; summary: string | null; file_size: number | null };

export type PageView = {
  page: TreeNode & {
    body: string;
    tags: string[];
    summary: string | null;
    link?: string | null;
    status: "active" | "archived";
    created_at: string;
    file_size: number | null;
    share_token?: string | null;
  };
  blocks: unknown[];
  breadcrumb: { id: number; title: string; icon: string | null }[];
  children: Child[];
  meeting: null | {
    id: number;
    status: string;
    has_audio: boolean;
    transcript_source: string | null;
    duration_sec: number | null;
    action_items: { task: string; owner?: string; due?: string }[];
  };
};

export type Hit = {
  id: number;
  title: string;
  kind: Kind;
  icon: string | null;
  path: string;
  tags: string[];
  summary: string | null;
  snippet: string;
  updated_at: string;
};

export function defaultIcon(kind: Kind, mime?: string | null): string {
  if (kind === "folder") return "📁";
  if (kind === "meeting") return "🎙️";
  if (kind === "file") {
    if (mime?.startsWith("image/")) return "🖼️";
    if (mime === "application/pdf") return "📕";
    if (mime?.startsWith("audio/")) return "🎧";
    if (mime?.startsWith("video/")) return "🎬";
    if (mime?.includes("sheet") || mime?.includes("csv")) return "📊";
    return "📎";
  }
  return "📄";
}

export function fmtDate(sqlite: string) {
  const d = new Date(sqlite.replace(" ", "T") + (sqlite.includes("Z") ? "" : "Z"));
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function fmtSize(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
