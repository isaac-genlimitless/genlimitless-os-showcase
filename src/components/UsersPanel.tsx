"use client";
// Settings -> Users: human management surface. All authority is enforced server-side; hiding here is cosmetic.
// Nothing here sends mail/texts or triggers an agent.
import { useCallback, useEffect, useState } from "react";

type U = {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  role: "admin" | "member";
  createdAt?: string | null;
  lastActiveAt?: string | null;
  disabled?: boolean;
  deactivated?: boolean;
  removedAt?: string | null;
  removed?: boolean;
};
type AuditRow = { at?: string; ts?: string; actor?: string; action?: string; target?: string; detail?: string };

const toIso = (v: unknown): string | null => {
  if (typeof v === "number" && v > 0) return new Date(v).toISOString();
  if (typeof v === "string" && v) return v;
  return null;
};
// The API sends snake_case rows with epoch-ms numbers and role "owner"; map to the shape this panel renders.
const normalize = (r: Record<string, unknown>): U => {
  const removedAt = toIso(r.removed_at ?? r.removedAt);
  const role = r.role === "owner" || r.role === "admin" ? "admin" : "member";
  return {
    id: String(r.id ?? ""),
    name: String(r.display_name ?? r.name ?? "") || String(r.email ?? r.id ?? ""),
    email: String(r.email ?? ""),
    phone: (r.phone as string | null | undefined) ?? null,
    role,
    createdAt: toIso(r.created_at ?? r.createdAt),
    lastActiveAt: toIso(r.last_active ?? r.lastActiveAt),
    disabled: r.status === "disabled" && !removedAt,
    removedAt,
    removed: !!removedAt,
  };
};

const fmt = (s?: string | null) => {
  if (!s) return "Never";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "Never" : d.toLocaleString();
};
const isRemoved = (u: U) => !!(u.removed || u.removedAt);
const isOff = (u: U) => !!(u.disabled || u.deactivated);
const status = (u: U) => (isRemoved(u) ? "Removed" : isOff(u) ? "Deactivated" : "Active");
const chipCls = (s: string) =>
  s === "Active" ? "bg-green-500/15 text-green-700 dark:text-green-300" : s === "Deactivated" ? "bg-amber-500/20 text-amber-800 dark:text-amber-300" : "bg-red-500/15 text-red-700 dark:text-red-300";
const btn = "min-h-[44px] px-3 rounded-lg border border-black/15 dark:border-white/20 text-sm font-semibold";

export default function UsersPanel() {
  const [users, setUsers] = useState<U[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [showRemoved, setShowRemoved] = useState(false);
  const [edit, setEdit] = useState<U | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<U | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/users?removed=1", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || j.message || "Could not load users.");
      const raw: Record<string, unknown>[] = Array.isArray(j) ? j : j.users || [];
      setUsers(raw.map(normalize));
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load users.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const loadAudit = useCallback(async () => {
    try {
      const r = await fetch("/api/users?audit=1", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || j.message || "Could not load the audit log.");
      setAudit(Array.isArray(j) ? j : j.audit || j.log || []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load the audit log.");
    }
  }, []);

  async function call(url: string, method: string, body?: unknown): Promise<boolean> {
    try {
      const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.error || j.message || "That didn't work.");
        return false;
      }
      setErr("");
      await load();
      if (auditOpen) loadAudit();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That didn't work.");
      return false;
    }
  }
  const patch = (u: U, body: Record<string, unknown>) => call(`/api/users/${encodeURIComponent(u.id)}`, "PATCH", body);

  const act = (u: U, action: "deactivate" | "reactivate" | "remove" | "restore") => call(`/api/users/${encodeURIComponent(u.id)}`, "POST", { action });

  async function saveEdit(u: U, v: { name: string; email: string; phone: string; role: U["role"] }) {
    if (v.name !== u.name || v.email !== u.email || v.phone !== (u.phone || "")) {
      const ok = await patch(u, { display_name: v.name, email: v.email || null, phone: v.phone || null });
      if (!ok) return;
    }
    if (v.role !== u.role) {
      const ok = await patch(u, { role: v.role === "admin" ? "owner" : "member" });
      if (!ok) return;
    }
    setEdit(null);
  }

  async function viewAs(u: U) {
    try {
      const r = await fetch("/api/auth/impersonate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: u.id }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setErr(j.error || j.message || "Could not start viewing as this user.");
      window.location.assign("/");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start viewing as this user.");
    }
  }

  const visible = users.filter((u) => showRemoved || !isRemoved(u));
  const removedCount = users.filter(isRemoved).length;

  function Actions({ u }: { u: U }) {
    const removed = isRemoved(u);
    const off = isOff(u);
    return (
      <div className="flex flex-wrap gap-2">
        {removed ? (
          <button className={btn} onClick={() => act(u, "restore")}>Restore</button>
        ) : (
          <>
            <button className={btn} onClick={() => setEdit(u)}>Edit</button>
            <button className={btn} onClick={() => act(u, off ? "reactivate" : "deactivate")}>{off ? "Reactivate" : "Deactivate"}</button>
            <button className={btn} onClick={() => setConfirmRemove(u)}>Remove</button>
            {u.role !== "admin" && !off && <button className={btn} onClick={() => viewAs(u)}>View as</button>}
          </>
        )}
      </div>
    );
  }

  const roleBadge = (u: U) => (
    <span className="inline-block rounded-full px-2 py-0.5 text-xs font-semibold bg-foreground/10">{u.role === "admin" ? "Admin" : "Member"}</span>
  );
  const chip = (u: U) => <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${chipCls(status(u))}`}>{status(u)}</span>;

  return (
    <div className="space-y-4 min-w-0">
      {err && <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm break-words">{err}</div>}
      {loading && <div className="text-sm opacity-70">Loading users…</div>}

      <label className="flex items-center gap-2 min-h-[44px] text-sm">
        <input type="checkbox" className="h-5 w-5" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
        Show removed{removedCount ? ` (${removedCount})` : ""}
      </label>

      {/* md and up: table */}
      <div className="hidden md:block overflow-x-auto">
        <table data-testid="users-table" className="w-full text-sm text-left">
          <thead>
            <tr className="border-b border-black/10 dark:border-white/10">
              {["Name", "Email", "Role", "Created", "Last active", "Status", "Actions"].map((h) => (
                <th key={h} className="py-2 pr-3 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((u) => (
              <tr key={u.id} data-testid="user-row" data-role={u.role} className="border-b border-black/5 dark:border-white/5 align-top">
                <td className="py-2 pr-3 font-medium">{u.name}</td>
                <td className="py-2 pr-3 break-all">{u.email}</td>
                <td className="py-2 pr-3">{roleBadge(u)}</td>
                <td className="py-2 pr-3">{fmt(u.createdAt)}</td>
                <td className="py-2 pr-3">{fmt(u.lastActiveAt)}</td>
                <td className="py-2 pr-3">{chip(u)}</td>
                <td className="py-2"><Actions u={u} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* below md: stacked cards */}
      <div className="md:hidden space-y-3">
        {visible.map((u) => (
          <div key={u.id} data-testid="user-card" data-role={u.role} className="rounded-xl border border-black/10 dark:border-white/15 p-3 space-y-2 min-w-0">
            <div className="font-semibold break-words">{u.name}</div>
            <div className="text-sm break-all">{u.email}</div>
            <div className="flex flex-wrap gap-2 items-center">{roleBadge(u)}{chip(u)}</div>
            <div className="text-xs opacity-80 break-words">Created: {fmt(u.createdAt)}</div>
            <div className="text-xs opacity-80 break-words">Last active: {fmt(u.lastActiveAt)}</div>
            <Actions u={u} />
          </div>
        ))}
      </div>
      {!loading && visible.length === 0 && !err && <div className="text-sm opacity-70">No users yet.</div>}

      <div className="rounded-xl border border-black/10 dark:border-white/15">
        <button
          type="button"
          className="w-full min-h-[44px] px-3 text-left font-semibold text-sm"
          aria-expanded={auditOpen}
          onClick={() => {
            const next = !auditOpen;
            setAuditOpen(next);
            if (next) loadAudit();
          }}
        >
          Admin audit log {auditOpen ? "▾" : "▸"}
        </button>
        {auditOpen && (
          <ul className="px-3 pb-3 space-y-1 text-xs">
            {(audit ?? []).length === 0 && <li className="opacity-70">{audit ? "Nothing recorded yet." : "Loading…"}</li>}
            {(audit ?? []).map((a, i) => (
              <li key={i} className="break-words">
                {fmt(a.at || a.ts)} · {a.actor ?? ""} · {a.action ?? ""} {a.target ?? ""} {a.detail ?? ""}
              </li>
            ))}
          </ul>
        )}
      </div>

      {edit && <EditDialog u={edit} onClose={() => setEdit(null)} err={err} onSave={(v) => saveEdit(edit, v)} />}

      {confirmRemove && (
        <Modal title={`Remove ${confirmRemove.name}?`} onClose={() => setConfirmRemove(null)}>
          <p className="text-sm">This is a soft remove: they lose access, but nothing is erased and you can restore them any time from “Show removed”.</p>
          <div className="flex flex-wrap gap-2 justify-end pt-3">
            <button className={btn} onClick={() => setConfirmRemove(null)}>Cancel</button>
            <button className={btn} onClick={async () => { const u = confirmRemove; setConfirmRemove(null); await act(u, "remove"); }}>Remove</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
      <div className="w-full max-w-md max-h-full overflow-y-auto rounded-xl bg-background p-4 space-y-3 break-words" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function EditDialog({ u, err, onClose, onSave }: { u: U; err: string; onClose: () => void; onSave: (v: { name: string; email: string; phone: string; role: U["role"] }) => void }) {
  const [name, setName] = useState(u.name);
  const [email, setEmail] = useState(u.email);
  const [phone, setPhone] = useState(u.phone || "");
  const [role, setRole] = useState(u.role);
  const input = "w-full min-h-[44px] rounded-lg border border-black/15 dark:border-white/20 bg-transparent px-3 text-base";
  return (
    <Modal title={`Edit ${u.name}`} onClose={onClose}>
      <label className="block text-sm">Name<input className={input} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="block text-sm">Email<input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label className="block text-sm">Phone<input className={input} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
      <label className="block text-sm">Role
        <select className={input} value={role} onChange={(e) => setRole(e.target.value as U["role"])}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <p className="text-xs opacity-80">Admins can see and manage everything, including other users. Members only get what you give them. Change this only for people you fully trust.</p>
      {err && <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm break-words">{err}</div>}
      <div className="flex flex-wrap gap-2 justify-end pt-2">
        <button className={btn} onClick={onClose}>Cancel</button>
        <button className={btn} onClick={() => onSave({ name, email, phone, role })}>Save</button>
      </div>
    </Modal>
  );
}
