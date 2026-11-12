"use client";
// Shows one artifact (the parent re-keys it when the artifact changes, which resets the edit state).
// Read-only in canon; editable (title + markdown body) inside a sandbox.
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type { Artifact } from "@/lib/creations/types";
import ModelView from "./ModelView";
import MapView from "./MapView";
import PlanView from "./PlanView";
import SitesView from "./SitesView";

// Kinds whose data is structured: edited as JSON in a sandbox (the model is edited through its own inputs).
const JSON_KINDS = new Set(["map", "plan", "sites"]);

const REMARK = [remarkGfm];
const REHYPE = [rehypeSanitize];

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown-body creation-md">
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE}>{text}</ReactMarkdown>
    </div>
  );
}

export default function ArtifactView({ artifact, editable, onSave, sourceRef = null, apiBase = "/api/creations" }: {
  apiBase?: string;
  artifact: Artifact;
  editable: boolean;
  /** "s<sandboxId>" or "v<versionId>": where this artifact is read from (used by the 3D site view). */
  sourceRef?: string | null;
  onSave?: (next: { key: string; kind: string; title: string; body: string; data: unknown }) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(artifact.title);
  const [body, setBody] = useState(artifact.body);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const structured = artifact.kind === "model" || JSON_KINDS.has(artifact.kind);
  const [json, setJson] = useState(() => (JSON_KINDS.has(artifact.kind) ? JSON.stringify(artifact.data, null, 2) : ""));

  async function save() {
    if (!onSave) return;
    setBusy(true);
    let data = artifact.data;
    if (JSON_KINDS.has(artifact.kind)) {
      try {
        data = JSON.parse(json);
      } catch {
        setBusy(false);
        return setErr("That data isn't valid JSON.");
      }
    }
    const e = await onSave({ key: artifact.key, kind: artifact.kind, title, body, data });
    setBusy(false);
    if (e) setErr(e);
    else setEditing(false);
  }

  const saveData = onSave ? (data: unknown) => onSave({ key: artifact.key, kind: artifact.kind, title: artifact.title, body: artifact.body, data }) : undefined;
  const src = artifact.kind === "space" ? (artifact.data as { src?: string } | null)?.src : undefined;

  return (
    <div data-testid={`artifact-${artifact.key}`} className="flex flex-col gap-3 min-h-0 h-full">
      <div className="flex items-start justify-between gap-3">
        {editing ? (
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} data-testid="artifact-title-input"
            className="flex-1 text-2xl font-bold bg-transparent border border-panel-border rounded-lg px-2 py-1" />
        ) : (
          <h2 className="text-2xl font-bold">{artifact.title}</h2>
        )}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] uppercase tracking-wide text-muted border border-panel-border rounded px-1.5 py-0.5">{artifact.kind}</span>
          {editable && artifact.kind !== "space" && !editing && (
            <button onClick={() => setEditing(true)} data-testid="artifact-edit" className="hover-pill text-xs border border-panel-border rounded-lg px-2 py-1">Edit</button>
          )}
        </div>
      </div>
      {err && <div role="alert" className="text-sm text-danger">{err}</div>}
      {editing ? (
        <>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} data-testid="artifact-body-input"
            className={`w-full ${structured ? "min-h-32" : "min-h-[50vh]"} font-mono text-sm bg-transparent border border-panel-border rounded-lg p-3`} />
          {JSON_KINDS.has(artifact.kind) && (
            <label className="flex flex-col gap-1 text-xs text-muted">
              {artifact.kind === "map" ? "Map data (columns of nodes, and edges between node ids)" : artifact.kind === "plan" ? "Plan data (lot_acres, building_depth_ft, zones with use, sqft and schedule; days 0=Sun…6=Sat)" : "Site finder data (criteria with weights, candidates with 0–10 scores; null = unknown)"}
              <textarea value={json} onChange={(e) => setJson(e.target.value)} data-testid="artifact-json"
                className="w-full min-h-[40vh] font-mono text-xs text-foreground bg-transparent border border-panel-border rounded-lg p-3" />
            </label>
          )}
          <div className="flex gap-2">
            <button onClick={save} disabled={busy || !title.trim()} data-testid="artifact-save" className="px-3 py-1.5 text-sm rounded-lg bg-accent text-background disabled:opacity-50">Save to sandbox</button>
            <button onClick={() => { setEditing(false); setTitle(artifact.title); setBody(artifact.body); }} className="hover-pill text-sm px-3 py-1.5">Cancel</button>
          </div>
        </>
      ) : src ? (
        <div className="flex-1 min-h-[60vh] flex flex-col gap-2">
          <a href={src} target="_blank" rel="noopener noreferrer" className="hover-pill text-xs self-end">Open full screen ↗</a>
          <iframe title={artifact.title} src={src} sandbox="allow-scripts" data-testid="artifact-frame" className="flex-1 w-full min-h-[60vh] border border-panel-border rounded-lg bg-black" />
        </div>
      ) : structured ? (
        <>
          {artifact.body && <Markdown text={artifact.body} />}
          {artifact.kind === "model" ? (
            <ModelView data={artifact.data} editable={editable} onSaveData={saveData} />
          ) : artifact.kind === "sites" ? (
            <SitesView data={artifact.data} editable={editable} onSaveData={saveData} />
          ) : artifact.kind === "plan" ? (
            <PlanView data={artifact.data} sourceRef={sourceRef} artifactKey={artifact.key} apiBase={apiBase} />
          ) : (
            <MapView data={artifact.data} />
          )}
        </>
      ) : artifact.body ? (
        <Markdown text={artifact.body} />
      ) : artifact.data != null ? (
        <pre className="text-xs whitespace-pre-wrap border border-panel-border rounded-lg p-3">{JSON.stringify(artifact.data, null, 2)}</pre>
      ) : (
        <p className="text-sm text-muted">Empty.{editable ? " Press Edit to start writing." : ""}</p>
      )}
    </div>
  );
}
