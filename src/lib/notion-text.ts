// Pure Notion text helpers (no db import, so they can be unit tested directly).

export type RichText = { plain_text: string; href?: string | null; annotations?: { bold?: boolean; italic?: boolean; code?: boolean; strikethrough?: boolean } };

export function rt(parts: RichText[] | unknown = []): string {
  if (!Array.isArray(parts)) return ""; // databases' title schema is {} not an array
  return (parts as RichText[])
    .map((p) => {
      let t = p.plain_text;
      const a = p.annotations || {};
      if (a.code) t = `\`${t}\``;
      if (a.bold) t = `**${t}**`;
      if (a.italic) t = `*${t}*`;
      if (a.strikethrough) t = `~~${t}~~`;
      if (p.href) t = `[${t}](${p.href})`;
      return t;
    })
    .join("");
}

export function titleOf(page: any): string {
  if (Array.isArray(page?.title)) return rt(page.title) || "Untitled"; // databases (object === "database") first
  const props = page?.properties || {};
  for (const v of Object.values(props) as any[]) if (v?.type === "title" && Array.isArray(v.title)) return rt(v.title) || "Untitled";
  return "Untitled";
}
