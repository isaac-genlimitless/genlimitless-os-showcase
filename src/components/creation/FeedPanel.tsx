"use client";
import { useOwnerName } from "../CellContext";
// The creation's feed: what needs a decision sits on top (proposals to canon); everything else is history.
import { useState } from "react";
import type { Change, CreationDetail, PromotionRow } from "@/lib/creations/types";
import { Markdown } from "./ArtifactView";

const OP_STYLE: Record<Change["op"], string> = {
  add: "text-success border-success",
  change: "text-info border-info",
  remove: "text-danger border-danger",
};

export function ChangeList({ changes }: { changes: Change[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="flex flex-col gap-1.5">
      {changes.map((c) => (
        <li key={c.key} className="text-sm">
          <button onClick={() => setOpen(open === c.key ? null : c.key)} className="flex items-center gap-2 text-left w-full">
            <span className={`text-[10px] uppercase border rounded px-1 ${OP_STYLE[c.op]}`}>{c.op}</span>
            <span className="flex-1 truncate">{c.title}</span>
            {c.conflict && <span className="text-[10px] text-danger" title="Canon changed this after the sandbox started; approving replaces canon's version">conflict</span>}
          </button>
          {open === c.key && (
            <div className="mt-2 grid gap-2 md:grid-cols-2 text-xs">
              <div className="border border-panel-border rounded p-2 max-h-72 overflow-auto">
                <div className="text-muted mb-1">Canon (before)</div>
                {c.before ? <Markdown text={c.before.body || "_(no text)_"} /> : <span className="text-muted">Not in canon</span>}
              </div>
              <div className="border border-panel-border rounded p-2 max-h-72 overflow-auto">
                <div className="text-muted mb-1">Proposed (after)</div>
                {c.after ? <Markdown text={c.after.body || "_(no text)_"} /> : <span className="text-muted">Removed</span>}
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function PromotionCard({ p, onDecide, canDecide }: { p: PromotionRow; onDecide: (id: number, d: "approve" | "decline") => Promise<void>; canDecide: boolean }) {
  const ownerName = useOwnerName();
  const [busy, setBusy] = useState(false);
  const decide = async (d: "approve" | "decline") => {
    setBusy(true);
    await onDecide(p.id, d);
    setBusy(false);
  };
  return (
    <div className="rounded-xl border border-gold bg-panel p-3 flex flex-col gap-2" data-testid={`promotion-${p.id}`}>
      <div className="text-sm font-semibold">Proposal from “{p.sandbox_title}”</div>
      <div className="text-xs text-muted">Based on canon v{p.base_version} · by {p.proposed_by}</div>
      {p.rationale && <p className="text-sm whitespace-pre-wrap">{p.rationale}</p>}
      <ChangeList changes={p.changes} />
      {!canDecide ? <div className="text-xs text-muted pt-1" data-testid="promotion-waiting">Waiting for {ownerName} to approve.</div> : <div className="flex gap-2 pt-1">
        <button disabled={busy} onClick={() => decide("approve")} data-testid="promotion-approve" className="px-3 py-1.5 text-sm rounded-lg bg-accent text-background disabled:opacity-50">Approve → new canon</button>
        <button disabled={busy} onClick={() => decide("decline")} data-testid="promotion-decline" className="hover-pill text-sm px-3 py-1.5">Decline</button>
      </div>}
    </div>
  );
}

function CommentBox({ onComment }: { onComment: (body: string) => Promise<void> }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form className="flex flex-col gap-1.5" onSubmit={async (e) => {
      e.preventDefault();
      if (!body.trim()) return;
      setBusy(true);
      await onComment(body.trim());
      setBody("");
      setBusy(false);
    }}>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} placeholder="Comment on this creation…" data-testid="comment-input"
        className="w-full min-h-16 text-sm bg-transparent border border-panel-border rounded-lg p-2" />
      <div><button disabled={busy || !body.trim()} data-testid="comment-submit" className="px-3 py-1 text-sm rounded-lg border border-panel-border hover-pill disabled:opacity-40">Comment</button></div>
    </form>
  );
}

export default function FeedPanel({ detail, onDecide, onViewVersion, onComment, onResolve }: {
  detail: CreationDetail;
  onDecide: (id: number, d: "approve" | "decline") => Promise<void>;
  onViewVersion: (versionId: number) => void;
  onComment: (body: string) => Promise<void>;
  onResolve: (feedId: number) => Promise<void>;
}) {
  const ownerName = useOwnerName();
  const pending = detail.promotions.filter((p) => p.status === "pending");
  const comments = detail.feed.filter((f) => f.kind === "comment" && !f.resolved_at);
  const history = detail.feed.filter((f) => f.resolved_at);
  const canDecide = detail.role === "owner";
  return (
    <aside className="flex flex-col gap-4" data-testid="creation-feed">
      <section>
        <h3 className="text-xs uppercase tracking-wide text-muted mb-2">{canDecide ? "Needs you" : "Proposals"}</h3>
        {pending.length ? (
          <div className="flex flex-col gap-3">{pending.map((p) => <PromotionCard key={p.id} p={p} onDecide={onDecide} canDecide={canDecide} />)}</div>
        ) : (
          <p className="text-sm text-muted">Nothing waiting. Proposals to change canon show up here{canDecide ? "" : ` until ${ownerName} decides`}.</p>
        )}
      </section>
      <section data-testid="comments">
        <h3 className="text-xs uppercase tracking-wide text-muted mb-2">Comments</h3>
        <ul className="flex flex-col gap-2 mb-3">
          {comments.map((f) => (
            <li key={f.id} className="rounded-lg border border-panel-border p-2 text-sm" data-testid={`comment-${f.id}`}>
              <div className="text-[11px] text-muted">{f.actor} · {f.title} · {f.created_at} UTC</div>
              <p className="whitespace-pre-wrap mt-1">{f.body}</p>
              {(canDecide || f.actor === detail.viewer) && (
                <button className="hover-pill text-xs mt-1" onClick={() => onResolve(f.id)} data-testid="comment-resolve">Done</button>
              )}
            </li>
          ))}
        </ul>
        <CommentBox onComment={onComment} />
      </section>
      <section>
        <h3 className="text-xs uppercase tracking-wide text-muted mb-2">Canon versions</h3>
        <ul className="flex flex-col gap-1 text-sm" data-testid="version-list">
          {detail.versions.map((v) => (
            <li key={v.id}>
              <button onClick={() => onViewVersion(v.id)} className="hover-pill text-left w-full">
                <span className="font-medium">v{v.number}</span> <span className="text-muted">· {v.note || "—"}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="text-xs uppercase tracking-wide text-muted mb-2">History</h3>
        <ul className="flex flex-col gap-2 text-sm">
          {history.slice(0, 40).map((f) => (
            <li key={f.id} className="text-muted">
              <div className="text-foreground/90">{f.title}</div>
              {f.kind === "comment" && <div className="text-foreground/70 whitespace-pre-wrap">{f.body}</div>}
              <div className="text-[11px]">{f.actor} · {f.created_at} UTC</div>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
