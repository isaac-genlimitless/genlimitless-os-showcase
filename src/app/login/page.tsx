"use client";

import { useState } from "react";
import { safeNext } from "@/lib/auth/next-url";

type Mode = "imessage" | "backup" | "totp";

function nextUrl(): string {
  return safeNext(window.location.search);
}

export default function LoginPage() {
  const [step, setStep] = useState<1 | 2>(1);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<Mode>("imessage");
  const [totpAvailable, setTotpAvailable] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  async function post(url: string, body: Record<string, unknown>) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data: Record<string, unknown> = {};
    try {
      data = await r.json();
    } catch {
      data = {};
    }
    return { status: r.status, data };
  }

  async function submitPassword(e: React.FormEvent, method?: string) {
    e.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    try {
      const { status, data } = await post("/api/auth/login", { username, password, method });
      if (status === 401) setError("Wrong username or password.");
      else if (status === 429) setError("Too many attempts. Wait 15 minutes and try again.");
      else if (status === 409) setError("Login has not been set up yet.");
      else if (status === 200) {
        setTotpAvailable(data.totpAvailable === true);
        setMode(method === "totp" ? "totp" : "imessage");
        if (data.reason) setError("Could not text a code right now. Try Resend code in a minute, or use a backup code.");
        setStep(2);
      } else setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    try {
      const { status } = await post("/api/auth/verify", { code, kind: mode });
      if (status === 200) {
        window.location.href = nextUrl();
        return;
      }
      if (status === 429) setError("Too many attempts. Wait 15 minutes and try again.");
      else if (status === 401) setError("That code is wrong or has expired. Request a new one or try again.");
      else setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError("");
    setInfo("");
    const { status, data } = await post("/api/auth/resend", {});
    if (status === 401) setError("Code expired. Go back and enter your password again.");
    else if (data.ok) setInfo("New code sent.");
    else if (data.reason === "cooldown") setError("Wait 30 seconds before asking for another code.");
    else if (data.reason === "rate_limited") setError("Too many codes requested. Try again later.");
    else setError("Could not send the code.");
  }

  const label =
    mode === "imessage" ? "Your login code" : mode === "backup" ? "Backup code" : "Authenticator app code";

  const field = "w-full rounded-xl border border-panel-border bg-background px-4 py-3 text-base outline-none focus:border-gold focus:ring-2 focus:ring-gold/30";
  const linkBtn = "text-sm text-muted hover:text-foreground underline underline-offset-4";

  return (
    <main className="min-h-dvh w-full flex items-center justify-center bg-background px-4 py-10" data-testid="login-page">
      <div className="w-full max-w-sm flex flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/app-icons/icon-192.png" alt="" width={56} height={56} className="rounded-2xl shadow-sm" />
          <div className="font-display text-2xl tracking-wide leading-none">
            <span className="text-foreground">GEN</span>
            <span className="text-accent">LIMITLESS</span>
          </div>
          <p className="text-sm text-muted">AI Operating System</p>
        </div>

        <div className="w-full rounded-2xl border border-panel-border bg-panel p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-5" aria-hidden>
            <span className={`h-1.5 flex-1 rounded-full ${step >= 1 ? "bg-accent" : "bg-wash-2"}`} />
            <span className={`h-1.5 flex-1 rounded-full ${step >= 2 ? "bg-accent" : "bg-wash-2"}`} />
          </div>
          {step === 1 ? (
            <form onSubmit={(e) => submitPassword(e)} className="flex flex-col gap-4">
              <div>
                <h1 className="text-xl font-semibold">Sign in</h1>
                <p className="text-sm text-muted mt-1">Enter your username or email and password. Next you&apos;ll confirm with a code.</p>
              </div>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">Username or email</span>
                <input
                  type="text"
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={field}
                  data-testid="login-username"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={field}
                />
              </label>
              <button type="submit" disabled={busy || !password}
                className="w-full rounded-xl bg-accent text-background font-medium py-3 disabled:opacity-50 transition-opacity">
                {busy ? "Checking…" : "Continue"}
              </button>
            </form>
          ) : (
            <form onSubmit={submitCode} className="flex flex-col gap-4">
              <div>
                <h1 className="text-xl font-semibold">Confirm it&apos;s you</h1>
                <p className="text-sm text-muted mt-1">
                  {mode === "imessage" ? "We sent a 6-digit code to your phone or email." : mode === "totp" ? "Open your authenticator app for the 6-digit code." : "Use one of your saved backup codes."}
                </p>
              </div>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">{label}</span>
                <input
                  type="text"
                  inputMode={mode === "backup" ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={mode === "backup" ? 20 : 6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className={`${field} text-center text-2xl tracking-[0.4em] font-semibold`}
                />
              </label>
              <button type="submit" disabled={busy || !code}
                className="w-full rounded-xl bg-accent text-background font-medium py-3 disabled:opacity-50 transition-opacity">
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <div className="flex flex-col items-center gap-2 pt-1">
                {mode === "imessage" && <button type="button" onClick={resend} className={linkBtn}>Resend code</button>}
                {totpAvailable && mode !== "totp" && (
                  <button type="button" onClick={() => { setMode("totp"); setCode(""); setError(""); }} className={linkBtn}>Use authenticator app</button>
                )}
                {mode !== "imessage" && (
                  <button type="button" onClick={() => { setMode("imessage"); setCode(""); setError(""); }} className={linkBtn}>Use the texted code</button>
                )}
                {mode !== "backup" && (
                  <button type="button" onClick={() => { setMode("backup"); setCode(""); setError(""); }} className={linkBtn}>Use a backup code</button>
                )}
                <button type="button" onClick={() => { setStep(1); setCode(""); setError(""); setInfo(""); }} className={linkBtn}>← Back</button>
              </div>
            </form>
          )}
          {error && <p role="alert" className="mt-4 rounded-lg bg-wash-1 px-3 py-2 text-sm text-danger">{error}</p>}
          {info && <p role="status" className="mt-4 rounded-lg bg-wash-1 px-3 py-2 text-sm text-success">{info}</p>}
        </div>
        <p className="text-xs text-muted text-center">You stay signed in on this device for 30 days after your last visit.</p>
      </div>
    </main>
  );
}
