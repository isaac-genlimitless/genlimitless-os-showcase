"use client";
import { useState } from "react";
import { MAX_MUSIC_MB, MAX_MUSIC_BYTES, DEFAULT_MUSIC_VOLUME } from "@/lib/slideshow/music-limits";

export type MusicValue = { file: string; volume: number };
const btn: React.CSSProperties = { padding: "8px 12px", fontSize: 15, borderRadius: 8, border: "1px solid #8886", background: "transparent", color: "inherit", cursor: "pointer", display: "inline-block" };
const ACCEPT = "audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav,.mp3,.m4a,.wav";

/** Background music for a slideshow: add / replace / remove a track and set its volume. Changes apply when the slideshow is saved. */
export default function MusicControl({ api, music, onChange, onMessage }: { api: string; music?: MusicValue; onChange: (m: MusicValue | undefined) => void; onMessage: (m: string) => void }) {
  const [busy, setBusy] = useState(false);

  async function upload(f: File) {
    if (f.size > MAX_MUSIC_BYTES) { onMessage(`${f.name} is ${Math.round(f.size / 1048576)} MB; the music limit is ${MAX_MUSIC_MB} MB.`); return; }
    setBusy(true); onMessage(`Uploading ${f.name}...`);
    try {
      const fd = new FormData();
      fd.append("file", f, f.name);
      const r = await fetch(`${api}/music`, { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.music?.file) { onChange({ file: d.music.file, volume: music?.volume ?? DEFAULT_MUSIC_VOLUME }); onMessage("Music added. Press Save slideshow to keep it."); }
      else onMessage(`Music failed: ${d.error || r.status}`);
    } catch { onMessage("Music upload failed."); }
    setBusy(false);
  }

  const picker = (label: string) => (
    <label style={btn}>{label}
      <input type="file" hidden disabled={busy} accept={ACCEPT} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
    </label>
  );

  return (
    <div data-testid="music-control" style={{ border: "1px solid #8883", borderRadius: 8, padding: 8, margin: "12px 0" }}>
      <strong>🎵 Background music</strong>
      {music ? (
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <audio controls preload="none" src={`${api}/music/${music.file}`} aria-label="Music preview" style={{ width: "100%" }} />
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>Volume
            <input type="range" min={0} max={100} step={5} aria-label="Music volume" style={{ flex: 1 }} value={Math.round(music.volume * 100)} onChange={(e) => onChange({ ...music, volume: Number(e.target.value) / 100 })} />
            <span>{Math.round(music.volume * 100)}%</span>
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {picker("Replace music")}
            <button type="button" style={btn} onClick={() => { if (confirm("Remove the music from this slideshow? (The audio file is kept.)")) onChange(undefined); }}>Remove music</button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>{picker("🎵 Add music")}</div>
      )}
      <p style={{ fontSize: 13, opacity: 0.75, marginBottom: 0 }}>MP3, M4A or WAV, up to {MAX_MUSIC_MB} MB. Plays softly behind the slideshow and loops. It starts when someone taps play (browsers require a tap), pauses while a video clip plays, and there is a ♪ button to mute it.</p>
    </div>
  );
}
