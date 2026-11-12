"use client";

import { useEffect, useState, use } from "react";

// One-time setup link: choose a password, confirm the texted/emailed code, get backup codes. The link is the
// credential; every step is checked by /api/auth/invite (owner cell).
type Step = "loading" | "invalid" | "password" | "code" | "done";

export default function SetupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [step, setStep] = useState<Step>("loading");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function post(body: Record<string, unknown>) {
    const r = await fetch("/api/auth/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ...body }),
    });
    let data: Record<string, unknown> = {};
    try { data = await r.json(); } catch { data = {}; }
    return { status: r.status, data };
  }

  useEffect(() => {
    post({ action: "check" }).then(({ status, data }) => {
      if (status === 200) { setName(String(data.name || "")); setStep("password"); } else setStep("invalid");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function savePassword(e: React.FormEvent) {
    e.preventDefault(); setError(""); setBusy(true);
    try {
      const a = await post({ action: "password", password });
      if (a.status === 400) return setError("Use at least 12 characters.");
      if (a.status !== 200) return setError("This link no longer works. Ask Owner for a new one.");
      const b = await post({ action: "send_code" });
      if (b.status !== 200) return setError("Something went wrong. Try again.");
      if (b.data.ok === false) setError("We couldn't send the code just now. Wait a minute, then reload this page.");
      setStep("code");
    } finally { setBusy(false); }
  }

  async function finish(e: React.FormEvent) {
    e.preventDefault(); setError(""); setBusy(true);
    try {
      const r = await post({ action: "complete", code });
      if (r.status === 200) { setBackup((r.data.backupCodes as string[]) || []); setStep("done"); }
      else if (r.status === 401) setError("That code is wrong or has expired.");
      else setError("This link no longer works. Ask Owner for a new one.");
    } finally { setBusy(false); }
  }

  const field = "w-full rounded-xl border border-panel-border bg-background px-4 py-3 text-base outline-none focus:border-gold focus:ring-2 focus:ring-gold/30";
  const btn = "w-full rounded-xl bg-accent text-background font-medium py-3 disabled:opacity-50 transition-opacity";
  return (
    <main className="min-h-dvh w-full flex items-center justify-center bg-background px-4 py-10" data-testid="setup-page">
      <div className="w-full max-w-sm rounded-2xl border border-panel-border bg-panel p-6 shadow-sm flex flex-col gap-4">
        {step === "loading" && <p className="text-sm text-muted">Checking your link…</p>}
        {step === "invalid" && (
          <div data-testid="setup-invalid">
            <h1 className="text-xl font-semibold">This link doesn&apos;t work</h1>
            <p className="text-sm text-muted mt-1">It may have expired, been used already, or been replaced. Ask Owner for a new one.</p>
          </div>
        )}
        {step === "password" && (
          <form onSubmit={savePassword} className="flex flex-col gap-4">
            <div>
              <h1 className="text-xl font-semibold">Welcome{name ? `, ${name}` : ""}</h1>
              <p className="text-sm text-muted mt-1">Choose a password (at least 12 characters). Next we&apos;ll send you a code to confirm it&apos;s you.</p>
            </div>
            <input type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} className={field} aria-label="New password" />
            <button type="submit" disabled={busy || !password} className={btn}>{busy ? "Saving…" : "Continue"}</button>
          </form>
        )}
        {step === "code" && (
          <form onSubmit={finish} className="flex flex-col gap-4">
            <div>
              <h1 className="text-xl font-semibold">Confirm it&apos;s you</h1>
              <p className="text-sm text-muted mt-1">Enter the 6-digit code we sent to your phone or email.</p>
            </div>
            <input type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} className={`${field} text-center text-2xl tracking-[0.4em] font-semibold`} aria-label="Code" />
            <button type="submit" disabled={busy || !code} className={btn}>{busy ? "Checking…" : "Finish setup"}</button>
          </form>
        )}
        {step === "done" && (
          <div className="flex flex-col gap-4" data-testid="setup-done">
            <div>
              <h1 className="text-xl font-semibold">You&apos;re all set</h1>
              <p className="text-sm text-muted mt-1">Save these backup codes somewhere safe. Each works once if you can&apos;t get a code.</p>
            </div>
            <pre className="rounded-lg bg-wash-1 p-3 text-sm select-all">{backup.join("\n")}</pre>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- full reload is intended after setup */}
            <a href="/" className={`${btn} text-center`}>Open GenLimitless</a>
          </div>
        )}
        {error && <p role="alert" className="rounded-lg bg-wash-1 px-3 py-2 text-sm text-danger">{error}</p>}
      </div>
    </main>
  );
}
