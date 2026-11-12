"use client";
// Owner-only: who's on this creation, invite a collaborator (Partner first), and manage their private link.
// A link is shown ONCE, right after it's made (only its hash is stored).
import { useCallback, useEffect, useState } from "react";

type Member = { person: string; name: string; role: string; has_link: number | boolean; last_seen_at: string | null };

async function post<T>(url: string, json: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d as T;
}

export default function MembersPanel({ slug, apiBase }: { slug: string; apiBase: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [name, setName] = useState("");
  const [role, setRole] = useState("collaborator");
  const [link, setLink] = useState<{ who: string; url: string } | null>(null);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);

  const load = useCallback(() => fetch(`${apiBase}/${slug}/members`).then((r) => r.json()).then((d) => setMembers(d.members ?? [])).catch(() => {}), [apiBase, slug]);
  useEffect(() => {
    fetch(`${apiBase}/${slug}/members`).then((r) => r.json()).then((d) => setMembers(d.members ?? [])).catch(() => {});
  }, [apiBase, slug]);

  const showLink = (who: string, token: string) => setLink({ who, url: `${window.location.origin}/c/${token}` });
  const act = async (fn: () => Promise<void>) => {
    setMsg("");
    try {
      await fn();
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <section className="rounded-xl border border-panel-border bg-panel px-3 py-1 flex flex-col gap-2" data-testid="members-panel">
      <button className="flex items-center justify-between gap-2 py-1.5 text-xs uppercase tracking-wide text-muted" onClick={() => setOpen((v) => !v)} data-testid="members-toggle">
        <span>People ({members.length})</span><span aria-hidden className="text-base leading-none">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 pb-3">
          <ul className="flex flex-col gap-1.5 text-sm">
            {members.map((m) => (
              <li key={m.person} className="flex flex-wrap items-center gap-2" data-testid={`member-${m.person}`}>
                <span className="font-medium">{m.name}</span>
                <span className="text-xs text-muted">{m.role}{m.role !== "owner" && (m.has_link ? (m.last_seen_at ? ` · last here ${m.last_seen_at} UTC` : " · link not opened yet") : " · no active link")}</span>
                {m.role !== "owner" && (
                  <span className="flex gap-1 ml-auto text-xs">
                    <button className="hover-pill" data-testid="member-new-link" onClick={() => act(async () => {
                      if (!window.confirm(`Make a new link for ${m.name}? Their current link stops working.`)) return;
                      const d = await post<{ token: string }>(`${apiBase}/people/${m.person}`, { action: "regenerate" });
                      showLink(m.name, d.token);
                    })}>New link</button>
                    <button className="hover-pill" data-testid="member-revoke" onClick={() => act(async () => {
                      if (!window.confirm(`Turn off ${m.name}'s link everywhere?`)) return;
                      await post(`${apiBase}/people/${m.person}`, { action: "revoke" });
                    })}>Revoke link</button>
                    <button className="hover-pill" data-testid="member-remove" onClick={() => act(async () => {
                      if (!window.confirm(`Take ${m.name} off this creation?`)) return;
                      await post(`${apiBase}/${slug}/members`, { action: "remove", person: m.person });
                    })}>Remove</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <form className="flex flex-wrap gap-1.5" onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              const d = await post<{ person: { name: string }; token: string | null }>(`${apiBase}/${slug}/members`, { name, role });
              if (d.token) showLink(d.person.name, d.token);
              else setMsg(`${d.person.name} already has a link, so it keeps working. Use "New link" if you need to see one again.`);
              setName("");
            });
          }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. Partner)" maxLength={60} required data-testid="invite-name"
              className="flex-1 min-w-24 text-sm bg-transparent border border-panel-border rounded-lg px-2 py-1" />
            <select value={role} onChange={(e) => setRole(e.target.value)} data-testid="invite-role" className="text-sm bg-transparent border border-panel-border rounded-lg px-1">
              <option value="collaborator">Collaborator</option>
              <option value="viewer">Viewer</option>
            </select>
            <button className="px-3 py-1 text-sm rounded-lg bg-accent text-background" data-testid="invite-submit">Invite</button>
          </form>
          {link && (
            <div className="rounded-lg bg-wash-1 p-2 text-xs flex flex-col gap-1" data-testid="invite-link">
              <span>Private link for <b>{link.who}</b>. It is shown only now, so copy it and send it to them yourself. Anyone with this link can open the creations {link.who} is on.</span>
              <code className="break-all select-all" data-testid="invite-link-url">{link.url}</code>
              <span className="flex gap-2">
                <button className="hover-pill" onClick={() => navigator.clipboard?.writeText(link.url).then(() => setMsg("Copied."))}>Copy</button>
                <button className="hover-pill" onClick={() => setLink(null)}>Hide</button>
              </span>
            </div>
          )}
          {msg && <p className="text-xs text-muted" role="status">{msg}</p>}
        </div>
      )}
    </section>
  );
}
