import { getPage } from "@/lib/pages";
import { listSlideshows } from "@/lib/slideshow/store";
import SlideshowEditor from "@/components/slideshow/SlideshowEditor";

export const dynamic = "force-dynamic";
const wrap = { padding: 16, maxWidth: 720, margin: "0 auto", overflow: "auto", height: "100%" } as const;

export default async function SlideshowPage({ searchParams }: { searchParams: Promise<{ file?: string }> }) {
  const raw = (await searchParams).file;
  const id = raw && /^[1-9][0-9]{0,11}$/.test(raw) ? Number(raw) : null;
  const page = id ? getPage(id) : undefined;
  if (!page) {
    const shows = listSlideshows().filter((s) => s.key.startsWith("file-"));
    return (
      <main style={wrap}>
        <h1>Slideshows</h1>
        {raw && <p>No file with id {raw}.</p>}
        <form method="get" style={{ display: "flex", gap: 8, alignItems: "end" }}>
          <label style={{ flex: 1 }}>Files page ID<input name="file" inputMode="numeric" pattern="[0-9]+" required style={{ width: "100%", padding: 8, fontSize: 16, boxSizing: "border-box" }} /></label>
          <button type="submit" style={{ padding: "8px 14px", fontSize: 16 }}>Open</button>
        </form>
        <ul>{shows.map((s) => <li key={s.key}><a href={`/slideshow?file=${s.key.slice(5)}`}>{s.title}</a> ({s.count} slides)</li>)}</ul>
      </main>
    );
  }
  const key = `file-${page.id}`;
  return (
    <main style={wrap}>
      <h1>Slideshow for “{page.title}”</h1>
      <p><a href={`/api/slideshows/${key}/play`} target="_blank" rel="noreferrer">Open full screen ▶</a></p>
      <SlideshowEditor slideshowKey={key} previewSrc={`/api/slideshows/${key}/play`} />
    </main>
  );
}
