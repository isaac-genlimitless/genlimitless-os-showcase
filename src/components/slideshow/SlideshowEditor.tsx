"use client";
import { useEffect, useState } from "react";
import SlideshowPlayer from "./SlideshowPlayer";
import MusicControl, { type MusicValue } from "./MusicControl";
import { slideDurationMs, VIDEO_MAX_SECONDS, VIDEO_MAX_MB } from "@/lib/slideshow/duration";

type Slide = { id: string; type: "photo"; photo: string; caption?: string } | { id: string; type: "video"; video: string; caption?: string } | { id: string; type: "quote"; text: string; name: string };
const MAX_VIDEO_BYTES = VIDEO_MAX_MB * 1024 * 1024;

/** Reads a video's length in the browser. Resolves null if it can't be read. */
function videoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    const done = (n: number | null) => { URL.revokeObjectURL(url); v.removeAttribute("src"); resolve(n); };
    v.preload = "metadata";
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    v.src = url;
  });
}
type Show = { key: string; title: string; unlockLocal?: string; slides: Slide[]; music?: MusicValue };

const box: React.CSSProperties = { width: "100%", padding: 8, margin: "4px 0", fontSize: 16, boxSizing: "border-box" };
const btn: React.CSSProperties = { padding: "8px 12px", fontSize: 15, borderRadius: 8, border: "1px solid #8886", background: "transparent", color: "inherit", cursor: "pointer" };
const MAX_SIDE = 2048;
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** Shrinks big photos in the browser (keeps orientation, no cropping). Falls back to the original file. */
async function shrink(file: File): Promise<Blob> {
  if (file.type === "image/gif" || typeof createImageBitmap !== "function") return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size <= 2.5 * 1024 * 1024 && /jpe?g|png|webp/.test(file.type)) { bmp.close(); return file; }
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext("2d");
    if (!ctx) { bmp.close(); return file; }
    ctx.fillStyle = "#fff8e7"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    const out = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.86));
    return out || file;
  } catch { return file; }
}

/** THE slideshow editor, shared by /birthday-admin and /slideshow. */
export default function SlideshowEditor({ slideshowKey, previewSrc, showUnlock = false, note }: { slideshowKey: string; previewSrc: string; showUnlock?: boolean; note?: string }) {
  const api = `/api/slideshows/${slideshowKey}`;
  const [show, setShow] = useState<Show | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    fetch(api).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then(setShow).catch(() => setMsg("Couldn't load the slideshow."));
  }, [api]);

  if (!show) return <p>{msg || "Loading slideshow…"}</p>;

  const set = (p: Partial<Show>) => { setShow({ ...show, ...p }); setDirty(true); };
  const setSlides = (slides: Slide[]) => set({ slides });
  const patch = (i: number, p: Partial<{ caption: string; text: string; name: string }>) => setSlides(show.slides.map((x, k) => (k === i ? ({ ...x, ...p } as Slide) : x)));
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= show.slides.length) return; const s = [...show.slides]; [s[i], s[j]] = [s[j], s[i]]; setSlides(s); };
  const remove = (i: number) => { if (confirm("Remove this slide from the slideshow? (The photo file is kept.)")) setSlides(show.slides.filter((_, k) => k !== i)); };

  async function addPhotos(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    const added: Slide[] = []; const errs: string[] = [];
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", await shrink(f), f.name);
      const r = await fetch(`${api}/photos`, { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.photo) added.push({ id: newId(), type: "photo", photo: d.photo }); else errs.push(`${f.name}: ${d.error || r.status}`);
    }
    setShow((s) => s && { ...s, slides: [...s.slides, ...added] });
    setDirty(true); setBusy(false);
    setMsg(errs.length ? `Some photos failed: ${errs.join("; ")}` : `Added ${added.length} photo(s). Press Save slideshow to keep them.`);
  }

  async function addVideos(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    const added: Slide[] = []; const errs: string[] = [];
    for (const f of files) {
      const mb = f.size / (1024 * 1024);
      if (f.size > MAX_VIDEO_BYTES) { errs.push(`${f.name} is ${Math.round(mb)} MB; the limit is ${VIDEO_MAX_MB} MB (about 5 minutes). Please shorten or compress it.`); continue; }
      const secs = await videoDuration(f);
      if (secs !== null && secs > VIDEO_MAX_SECONDS) {
        const t = Math.round(secs);
        errs.push(`${f.name} is ${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")} long; videos can be at most 5 minutes. Please trim it first.`);
        continue;
      }
      setMsg(`Uploading ${f.name} (${Math.round(mb)} MB)...`);
      try {
        const fd = new FormData();
        fd.append("file", f, f.name);
        const r = await fetch(`${api}/videos`, { method: "POST", body: fd });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.video) added.push({ id: newId(), type: "video", video: d.video }); else errs.push(`${f.name}: ${d.error || r.status}`);
      } catch { errs.push(`${f.name}: upload failed`); }
    }
    setShow((s) => s && { ...s, slides: [...s.slides, ...added] });
    setDirty(true); setBusy(false);
    setMsg(errs.length ? `Some videos failed: ${errs.join("; ")}` : `Added ${added.length} video(s). Press Save slideshow to keep them.`);
  }

  async function save() {
    setBusy(true);
    const r = await fetch(api, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(show) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { setShow(d.slideshow); setDirty(false); setRev((n) => n + 1); setMsg("Saved ✔"); } else setMsg(`Error: ${d.error || r.status}`);
  }

  return (
    <section style={{ border: "1px solid #8884", borderRadius: 12, padding: 12, margin: "16px 0" }}>
      <h2 style={{ marginTop: 0 }}>Slideshow</h2>
      {note && <p style={{ fontSize: 14, opacity: 0.8 }}>{note}</p>}
      <label>Title<input style={box} maxLength={120} value={show.title} onChange={(e) => set({ title: e.target.value })} /></label>
      {showUnlock && (() => {
        const [d = "", t = ""] = (show.unlockLocal || "").split(" ");
        const setDT = (nd: string, nt: string) => { if (nd) set({ unlockLocal: `${nd} ${nt || "00:00"}` }); }; // no time set -> start of day (12:00 AM Central)
        return (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <label style={{ flex: 1, minWidth: 150 }}>Unlock date (Central)
              <input style={box} type="date" value={d} onChange={(e) => setDT(e.target.value, t)} />
            </label>
            <label style={{ flex: 1, minWidth: 130 }}>Unlock time (Central)
              <input style={box} type="time" step={60} value={t} onChange={(e) => setDT(d, e.target.value)} />
            </label>
          </div>
        );
      })()}
      <ol style={{ paddingLeft: 20 }}>
        {show.slides.map((s, i) => (
          <li key={s.id} style={{ margin: "10px 0", border: "1px solid #8883", borderRadius: 8, padding: 8 }}>
            {s.type === "photo" ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${api}/photos/${s.photo}`} alt="" style={{ width: 88, height: 88, objectFit: "contain", background: "#fff8e7", borderRadius: 6, flex: "none" }} />
                <input style={box} aria-label="Caption" placeholder="Caption (optional)" maxLength={200} value={s.caption || ""} onChange={(e) => patch(i, { caption: e.target.value })} />
              </div>
            ) : s.type === "video" ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <video src={`${api}/photos/${s.video}`} muted preload="metadata" style={{ width: 88, height: 88, objectFit: "contain", background: "#000", borderRadius: 6, flex: "none" }} />
                <input style={box} aria-label="Caption" placeholder="Caption (optional)" maxLength={200} value={s.caption || ""} onChange={(e) => patch(i, { caption: e.target.value })} />
              </div>
            ) : (
              <>
                <textarea style={{ ...box, minHeight: 80 }} aria-label="Quote" placeholder="Quote" maxLength={800} value={s.text} onChange={(e) => patch(i, { text: e.target.value })} />
                <input style={box} aria-label="Quote name" placeholder="Who said it" maxLength={80} value={s.name} onChange={(e) => patch(i, { name: e.target.value })} />
              </>
            )}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <button type="button" style={btn} aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" style={btn} aria-label="Move down" disabled={i === show.slides.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" style={btn} onClick={() => remove(i)}>Remove slide</button>
              <span style={{ fontSize: 13, opacity: 0.7 }}>{s.type === "photo" ? "Photo · 3s" : s.type === "video" ? "Video · plays in full (up to 5 min)" : `Quote · ${(slideDurationMs(s) / 1000).toFixed(1)}s`}</span>
            </div>
          </li>
        ))}
      </ol>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label style={{ ...btn, display: "inline-block" }}>📷 Add photos
          <input type="file" hidden multiple disabled={busy} accept="image/jpeg,image/png,image/webp,image/gif" onChange={(e) => { const list = Array.from(e.target.files || []); e.target.value = ""; void addPhotos(list); }} />
        </label>
        <label style={{ ...btn, display: "inline-block" }}>🎬 Add video
          <input type="file" hidden multiple disabled={busy} accept="video/mp4,video/webm,video/quicktime" onChange={(e) => { const list = Array.from(e.target.files || []); e.target.value = ""; void addVideos(list); }} />
        </label>
        <button type="button" style={btn} onClick={() => setSlides([...show.slides, { id: newId(), type: "quote", text: "", name: "" }])}>❝ Add quote</button>
      </div>
      <p style={{ fontSize: 13, opacity: 0.75 }}>Videos: MP4 or WebM, up to 5 minutes and 200 MB. They play start to finish. iPhone .mov plays in Safari; use MP4 (H.264) if it won&apos;t play elsewhere.</p>
      <MusicControl api={api} music={show.music} onChange={(m) => set({ music: m })} onMessage={setMsg} />
      <button type="button" disabled={busy} onClick={save} style={{ ...box, marginTop: 12, background: "#f2b705", color: "#3b2a14", border: 0, fontWeight: 700 }}>
        {busy ? "Working…" : dirty ? "Save slideshow" : "Saved"}
      </button>
      <p role="status">{msg}</p>
      <h3>Preview (last saved version)</h3>
      <SlideshowPlayer key={rev} src={previewSrc} title={`${show.title} preview`} />
    </section>
  );
}
