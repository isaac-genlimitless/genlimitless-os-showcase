// Pure helpers for the @ pickers (no JSX, no db import) so the client and the tests can share them.

export type MentionApiItem = { type: string; id: number; title?: string | null; url: string; updated_at?: string | null };

export const MENTION_KIND: Record<string, { label: string; plural: string; icon: string; order: number }> = {
  page: { label: "Page", plural: "Pages", icon: "📄", order: 1 },
  meeting: { label: "Meeting", plural: "Meetings", icon: "🎙️", order: 2 },
  task: { label: "Task", plural: "Tasks", icon: "✅", order: 3 },
};

const RESERVED = new Set(["assistant", "pages", "meetings", "tasks", "items", "chief"]);

/** Title shown for an item; never empty. */
export function mentionDisplayTitle(it: MentionApiItem): string {
  const t = String(it.title ?? "").replace(/\s+/g, " ").trim();
  if (t) return t;
  return `Untitled ${(MENTION_KIND[it.type]?.label || "item").toLowerCase()}`;
}

export type EditorMentionRow = { title: string; subtext: string; group: string; icon: string; text: string; url: string; id: number; type: string };

/** Rows for the Files-editor picker: skips items without a usable url/id, sorts into CONTIGUOUS groups (Pages, Meetings, Tasks; API order kept inside each group), and makes every `title` unique because BlockNote keys rows by title and group labels by group name. Duplicates get " (#id)". `text` is the real title used for the inserted chip. */
export function buildEditorMentionRows(items: MentionApiItem[]): EditorMentionRow[] {
  const seen = new Set<string>(RESERVED);
  const kept = (items || []).filter((it) => it && typeof it.url === "string" && it.url && Number.isFinite(Number(it.id)));
  const ranked = kept.map((it, i) => ({ it, i, o: MENTION_KIND[it.type]?.order ?? 9 })).sort((a, b) => a.o - b.o || a.i - b.i);
  return ranked.map(({ it }) => {
    const k = MENTION_KIND[it.type] || { label: "Item", plural: "Items", icon: "🔗", order: 9 };
    const text = mentionDisplayTitle(it);
    let title = text;
    if (seen.has(title.toLowerCase())) title = `${text} (#${it.id})`;
    seen.add(title.toLowerCase());
    const date = String(it.updated_at || "").slice(0, 10);
    return { title, subtext: date ? `${k.label} · ${date}` : k.label, group: k.plural, icon: k.icon, text, url: it.url, id: Number(it.id), type: it.type };
  });
}
