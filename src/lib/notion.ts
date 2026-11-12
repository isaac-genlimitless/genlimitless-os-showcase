import db from "./db";
import { rt, titleOf, type RichText } from "./notion-text";

// Owner's real Notion workspace, through an internal integration token (NOTION_TOKEN in
// .env.local). The integration only sees pages and databases Owner has shared with it
// (Notion page → ••• → Connections → add the integration).
//
// Guardrails (enforced by the agent tools, see agents/tools.ts):
//  - reading and searching: free
//  - creating pages, and editing pages the OS itself created: free (tracked in notion_owned)
//  - editing any other page, and archiving anything: an approval request for Owner
// No new npm dependency: plain fetch against the public API.

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

export class NotionNotConnected extends Error {}

db.exec(`
CREATE TABLE IF NOT EXISTS notion_owned (
  page_id TEXT PRIMARY KEY,          -- pages the OS created (it may keep editing these)
  title TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export const isNotionConnected = () => !!process.env.NOTION_TOKEN;

async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new NotionNotConnected("Notion isn't connected yet: NOTION_TOKEN is missing from .env.local.");
  const res = await fetch(`${API}${path}`, {
    method: init.method || "GET",
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new NotionNotConnected("Notion rejected the token (it may have been revoked). Owner needs to update NOTION_TOKEN.");
  if (res.status === 404)
    throw new Error("Notion can't see that page/database. Owner has to share it with the integration: open it in Notion → ••• → Connections → add the GenLimitless OS integration.");
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${data.message || JSON.stringify(data).slice(0, 300)}`);
  return data;
}

/** Accepts a page id, a dashed id, or a notion.so URL. */
export function normalizeId(ref: string): string {
  const path = ref.trim().split(/[?#]/)[0].replace(/-/g, ""); // drop ?pvs=4, #block-anchors
  const hex = path.match(/[0-9a-f]{32}(?![0-9a-f])/gi)?.pop() || path;
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`Not a Notion page id or URL: ${ref}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
}

// ---------------------------------------------------------------- rich text / blocks → markdown


/** A database row's properties as readable "name: value" pairs. */
export function propertiesToText(props: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(props || {})) {
    let s = "";
    switch (v?.type) {
      case "title": s = rt(v.title); break;
      case "rich_text": s = rt(v.rich_text); break;
      case "number": s = v.number == null ? "" : String(v.number); break;
      case "select": s = v.select?.name || ""; break;
      case "status": s = v.status?.name || ""; break;
      case "multi_select": s = (v.multi_select || []).map((o: any) => o.name).join(", "); break;
      case "date": s = v.date ? `${v.date.start}${v.date.end ? ` → ${v.date.end}` : ""}` : ""; break;
      case "checkbox": s = v.checkbox ? "yes" : "no"; break;
      case "url": s = v.url || ""; break;
      case "email": s = v.email || ""; break;
      case "phone_number": s = v.phone_number || ""; break;
      case "people": s = (v.people || []).map((p: any) => p.name || p.id).join(", "); break;
      case "relation": s = (v.relation || []).map((r: any) => r.id).join(", "); break;
      case "formula": s = String(v.formula?.[v.formula?.type] ?? ""); break;
      case "rollup": s = JSON.stringify(v.rollup?.[v.rollup?.type] ?? ""); break;
      case "created_time": s = v.created_time; break;
      case "last_edited_time": s = v.last_edited_time; break;
      default: s = "";
    }
    if (s) out[name] = s;
  }
  return out;
}

async function children(blockId: string, max = 400): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const d = await api(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    out.push(...d.results);
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor && out.length < max);
  return out;
}

async function blocksToMarkdown(blocks: any[], depth: number, budget: { left: number }): Promise<string> {
  const lines: string[] = [];
  const pad = "  ".repeat(depth);
  let n = 0;
  for (const b of blocks) {
    if (budget.left-- <= 0) {
      lines.push(`${pad}…(page continues; truncated)`);
      break;
    }
    const v = b[b.type] || {};
    const text = rt(v.rich_text);
    switch (b.type) {
      case "paragraph": lines.push(pad + text); break;
      case "heading_1": lines.push(`${pad}# ${text}`); break;
      case "heading_2": lines.push(`${pad}## ${text}`); break;
      case "heading_3": lines.push(`${pad}### ${text}`); break;
      case "bulleted_list_item": lines.push(`${pad}- ${text}`); break;
      case "numbered_list_item": lines.push(`${pad}${++n}. ${text}`); break;
      case "to_do": lines.push(`${pad}- [${v.checked ? "x" : " "}] ${text}`); break;
      case "toggle": lines.push(`${pad}▸ ${text}`); break;
      case "quote": lines.push(`${pad}> ${text}`); break;
      case "callout": lines.push(`${pad}> ${v.icon?.emoji || "💡"} ${text}`); break;
      case "code": lines.push(`${pad}\`\`\`${v.language || ""}\n${text}\n${pad}\`\`\``); break;
      case "divider": lines.push(`${pad}---`); break;
      case "child_page": lines.push(`${pad}📄 Sub-page: ${v.title} (id ${b.id})`); break;
      case "child_database": lines.push(`${pad}🗂 Database: ${v.title} (id ${b.id})`); break;
      case "bookmark": case "embed": case "link_preview": lines.push(`${pad}${v.url}`); break;
      case "image": case "file": case "pdf": case "video":
        lines.push(`${pad}[${b.type}: ${rt(v.caption) || v.name || ""}](${v.file?.url || v.external?.url || ""})`);
        break;
      case "table_row": lines.push(`${pad}| ${(v.cells || []).map((c: RichText[]) => rt(c)).join(" | ")} |`); break;
      default: if (text) lines.push(pad + text);
    }
    if (b.type !== "numbered_list_item") n = 0;
    if (b.has_children && depth < 3 && !["child_page", "child_database"].includes(b.type)) {
      lines.push(await blocksToMarkdown(await children(b.id, 100), depth + 1, budget));
    }
  }
  return lines.filter((l) => l !== undefined).join("\n");
}

// ---------------------------------------------------------------- markdown → blocks (for writing)

function textRuns(s: string): any[] {
  // Links [text](url) and **bold**; everything else plain. Notion caps a text run at 2000 chars.
  const out: any[] = [];
  const re = /\[([^\]]+)\]\((https?:[^)]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (content: string, extra: Record<string, unknown> = {}) => {
    for (let i = 0; i < content.length; i += 2000) out.push({ type: "text", text: { content: content.slice(i, i + 2000), ...extra } });
  };
  while ((m = re.exec(s))) {
    if (m.index > last) push(s.slice(last, m.index));
    if (m[1]) push(m[1], { link: { url: m[2] } });
    else out.push({ type: "text", text: { content: m[3] }, annotations: { bold: true } });
    last = m.index + m[0].length;
  }
  if (last < s.length) push(s.slice(last));
  return out;
}

export function markdownToBlocks(md: string): any[] {
  const blocks: any[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const block = (type: string, text: string, extra: Record<string, unknown> = {}) => ({ object: "block", type, [type]: { rich_text: textRuns(text), ...extra } });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || "plain text";
      const body: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) body.push(lines[i]);
      blocks.push(block("code", body.join("\n"), { language: lang }));
      continue;
    }
    if (!line.trim()) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) blocks.push(block(`heading_${m[1].length}`, m[2]));
    else if ((m = line.match(/^\s*[-*]\s+\[( |x)\]\s+(.*)$/i))) blocks.push(block("to_do", m[2], { checked: m[1].toLowerCase() === "x" }));
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) blocks.push(block("bulleted_list_item", m[1]));
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) blocks.push(block("numbered_list_item", m[1]));
    else if ((m = line.match(/^>\s?(.*)$/))) blocks.push(block("quote", m[1]));
    else if (/^-{3,}$/.test(line.trim())) blocks.push({ object: "block", type: "divider", divider: {} });
    else blocks.push(block("paragraph", line));
  }
  return blocks;
}

async function appendBlocks(pageId: string, blocks: any[]) {
  for (let i = 0; i < blocks.length; i += 100) await api(`/blocks/${pageId}/children`, { method: "PATCH", body: { children: blocks.slice(i, i + 100) } });
}

// ---------------------------------------------------------------- operations

export async function searchNotion(query: string, kind?: "page" | "database", limit = 15) {
  const d = await api("/search", {
    method: "POST",
    body: { query, page_size: Math.min(limit, 50), ...(kind ? { filter: { property: "object", value: kind } } : {}), sort: { direction: "descending", timestamp: "last_edited_time" } },
  });
  return (d.results || []).map((r: any) => ({
    id: r.id,
    type: r.object,
    title: titleOf(r),
    url: r.url,
    last_edited: r.last_edited_time,
    parent: r.parent?.type === "database_id" ? `row in database ${r.parent.database_id}` : r.parent?.type,
    owned_by_os: isOwned(r.id),
  }));
}

export async function readPage(ref: string, maxBlocks = 600) {
  const id = normalizeId(ref);
  const page = await api(`/pages/${id}`);
  const body = await blocksToMarkdown(await children(id), 0, { left: maxBlocks });
  return {
    id,
    title: titleOf(page),
    url: page.url,
    last_edited: page.last_edited_time,
    properties: page.parent?.type === "database_id" ? propertiesToText(page.properties) : undefined,
    owned_by_os: isOwned(id),
    markdown: body,
  };
}

export async function queryDatabase(ref: string, opts: { filter?: unknown; sorts?: unknown; limit?: number } = {}) {
  const id = normalizeId(ref);
  const dbInfo = await api(`/databases/${id}`);
  const d = await api(`/databases/${id}/query`, {
    method: "POST",
    body: { page_size: Math.min(opts.limit ?? 50, 100), ...(opts.filter ? { filter: opts.filter } : {}), ...(opts.sorts ? { sorts: opts.sorts } : {}) },
  });
  return {
    id,
    title: titleOf(dbInfo),
    columns: Object.entries(dbInfo.properties || {}).map(([name, p]: [string, any]) => `${name} (${p.type}${p.select ? `: ${p.select.options.map((o: any) => o.name).join("/")}` : p.status ? `: ${p.status.options.map((o: any) => o.name).join("/")}` : ""})`),
    rows: (d.results || []).map((r: any) => ({ id: r.id, url: r.url, ...propertiesToText(r.properties) })),
    has_more: !!d.has_more,
  };
}

export function isOwned(pageId: string) {
  return !!db.prepare(`SELECT 1 FROM notion_owned WHERE page_id=?`).get(normalizeId(pageId));
}

/** Create a page under a parent page, or as a row in a database (then `properties` sets its columns). */
export async function createNotionPage(input: { parent: string; title: string; markdown?: string; properties?: Record<string, unknown>; created_by: string }) {
  const parentId = normalizeId(input.parent);
  // Is the parent a database or a page?
  let parentIsDb = false;
  let titleProp = "title";
  try {
    const d = await api(`/databases/${parentId}`);
    parentIsDb = true;
    titleProp = (Object.entries(d.properties || {}) as [string, any][]).find(([, p]) => p.type === "title")?.[0] || "Name";
  } catch {
    parentIsDb = false;
  }
  const blocks = markdownToBlocks(input.markdown || "");
  const page = await api("/pages", {
    method: "POST",
    body: {
      parent: parentIsDb ? { database_id: parentId } : { page_id: parentId },
      properties: { ...(input.properties || {}), [titleProp]: { title: [{ type: "text", text: { content: input.title.slice(0, 2000) } }] } },
      children: blocks.slice(0, 100),
    },
  });
  if (blocks.length > 100) await appendBlocks(page.id, blocks.slice(100));
  db.prepare(`INSERT OR IGNORE INTO notion_owned (page_id, title, created_by) VALUES (?, ?, ?)`).run(normalizeId(page.id), input.title, input.created_by);
  return { id: page.id, url: page.url, title: input.title };
}

export async function appendToPage(ref: string, markdown: string) {
  const id = normalizeId(ref);
  await appendBlocks(id, markdownToBlocks(markdown));
  return { id, appended: true };
}

export async function updateProperties(ref: string, properties: Record<string, unknown>) {
  const id = normalizeId(ref);
  const page = await api(`/pages/${id}`, { method: "PATCH", body: { properties } });
  return { id, url: page.url, updated: Object.keys(properties) };
}

/** Archive = Notion's Trash (restorable for 30 days). Only after Owner approves. */
export async function archiveNotionPage(ref: string) {
  const id = normalizeId(ref);
  await api(`/pages/${id}`, { method: "PATCH", body: { archived: true } });
  return { id, archived: true };
}

/** Un-archive a page (takes it back out of Notion's Trash). Used by Redo of an undone page creation. */
export async function restoreNotionPage(ref: string) {
  const id = normalizeId(ref);
  await api(`/pages/${id}`, { method: "PATCH", body: { archived: false } });
  return { id, archived: false };
}

const textOf = (arr: any[] | undefined) => (arr || []).map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("");

/** A raw Notion property converted to the payload accepted when writing it back; undefined for types we can't write. */
export function writableProperty(p: any): unknown {
  if (!p || typeof p !== "object") return undefined;
  switch (p.type) {
    case "title": return { title: [{ type: "text", text: { content: textOf(p.title).slice(0, 2000) } }] };
    case "rich_text": return { rich_text: textOf(p.rich_text) ? [{ type: "text", text: { content: textOf(p.rich_text).slice(0, 2000) } }] : [] };
    case "number": return { number: p.number ?? null };
    case "select": return { select: p.select ? { name: p.select.name } : null };
    case "multi_select": return { multi_select: (p.multi_select || []).map((o: any) => ({ name: o.name })) };
    case "status": return { status: p.status ? { name: p.status.name } : null };
    case "date": return { date: p.date ? { start: p.date.start, end: p.date.end ?? null, time_zone: p.date.time_zone ?? null } : null };
    case "checkbox": return { checkbox: !!p.checkbox };
    case "url": return { url: p.url ?? null };
    case "email": return { email: p.email ?? null };
    case "phone_number": return { phone_number: p.phone_number ?? null };
    case "people": return { people: (p.people || []).map((u: any) => ({ id: u.id })) };
    case "relation": return { relation: (p.relation || []).map((r: any) => ({ id: r.id })) };
    default: return undefined;
  }
}

/** Current values of the named properties in write format. Names that are missing or of an unsupported type go to `unsupported`. */
export async function readWritableProperties(ref: string, names: string[]) {
  const id = normalizeId(ref);
  const page = await api(`/pages/${id}`);
  const props: Record<string, unknown> = {};
  const unsupported: string[] = [];
  for (const n of names) {
    const w = writableProperty(page.properties?.[n]);
    if (w === undefined) unsupported.push(n);
    else props[n] = w;
  }
  return { title: titleOf(page), props, unsupported };
}

/** Who the token belongs to and how much it can see (for the Analytics status line). */
export async function notionStatus() {
  if (!isNotionConnected()) return { connected: false as const };
  try {
    const me = await api("/users/me");
    const shared = await api("/search", { method: "POST", body: { page_size: 100 } });
    return { connected: true as const, bot: me.name || "integration", workspace: me.bot?.workspace_name || null, shared: (shared.results || []).length, more: !!shared.has_more };
  } catch (e: any) {
    return { connected: false as const, error: e.message };
  }
}
