"use client";

import { useCallback, useEffect, useState } from "react";

interface SessionRow {
  id: number;
  created_at: number;
  last_seen_at: number | null;
  ip: string | null;
  user_agent: string | null;
  current?: boolean;
}

interface SecurityState {
  enrolled: boolean;
  enforce: boolean;
  totpEnabled: boolean;
  backupCodesLeft: number;
  sessions: SessionRow[];
}

function groupBy4(s: string): string {
  return s.replace(/(.{4})/g, "$1 ").trim();
}

export default function SecurityPage() {
  const [state, setState] = useState<SecurityState | null>(null);
  const [error, setError] = useState("");
  const [newCodes, setNewCodes] = useState<string[]>([]);
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/security");
      setState(await r.json());
    } catch {
      setError("Could not load security settings.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setError("");
    const r = await fetch("/api/auth/security", {
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
    if (r.status === 401) setError("Sign in first (you need a valid session for this).");
    else if (r.status === 409) setError("Login isn't set up yet.");
    else if (!r.ok) setError("That didn't work.");
    return { ok: r.ok, data };
  }

  if (!state) return <main style={{ padding: 24 }}>{error || "Loading…"}</main>;
  if (!state.enrolled) {
    return (
      <main style={{ maxWidth: 560, margin: "40px auto", padding: 16 }}>
        <h1>Security</h1>
        <p>Login isn&apos;t set up yet. <a href="/security/setup">Set it up</a>.</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", padding: 16, fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 22 }}>Security</h1>
      {error && <p role="alert" style={{ color: "#b00020" }}>{error}</p>}

      <section>
        <h2 style={{ fontSize: 16 }}>Backup codes</h2>
        <p>{state.backupCodesLeft} left.</p>
        <button
          onClick={async () => {
            const { ok, data } = await act({ action: "regen_backup" });
            if (ok && Array.isArray(data.backupCodes)) setNewCodes(data.backupCodes as string[]);
            load();
          }}
        >
          Regenerate
        </button>
        {newCodes.length > 0 && (
          <div>
            <p>Save these somewhere safe; each works once. They won&apos;t be shown again.</p>
            <pre style={{ background: "#f4f4f4", padding: 12 }}>{newCodes.join("\n")}</pre>
          </div>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 16 }}>Authenticator app (optional)</h2>
        {state.totpEnabled ? (
          <button onClick={async () => { await act({ action: "totp_disable" }); setTotp(null); load(); }}>Disable</button>
        ) : totp ? (
          <div>
            <p>Enter this secret in your authenticator app:</p>
            <pre style={{ background: "#f4f4f4", padding: 12, userSelect: "all" }}>{groupBy4(totp.secret)}</pre>
            <p>Or the otpauth link:</p>
            <pre style={{ background: "#f4f4f4", padding: 12, userSelect: "all", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{totp.uri}</pre>
            <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />{" "}
            <button
              onClick={async () => {
                const { ok } = await act({ action: "totp_confirm", code: totpCode });
                if (ok) { setTotp(null); setTotpCode(""); load(); }
              }}
            >
              Confirm
            </button>
          </div>
        ) : (
          <button
            onClick={async () => {
              const { ok, data } = await act({ action: "totp_begin" });
              if (ok && typeof data.secret === "string" && typeof data.uri === "string") {
                setTotp({ secret: data.secret, uri: data.uri });
              }
            }}
          >
            Set up
          </button>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 16 }}>Signed-in devices</h2>
        <ul>
          {state.sessions.map((s) => (
            <li key={s.id}>
              {s.current ? "This device · " : ""}
              {s.ip || "unknown IP"} · {s.user_agent || "unknown device"} · last seen{" "}
              {s.last_seen_at ? new Date(s.last_seen_at).toLocaleString() : "never"}
            </li>
          ))}
        </ul>
        <button onClick={async () => { await act({ action: "revoke_others" }); load(); }}>Sign out other devices</button>{" "}
        <button
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            window.location.href = "/login";
          }}
        >
          Sign out
        </button>
      </section>

      <section>
        <h2 style={{ fontSize: 16 }}>Require login</h2>
        <p>Sign in once from your phone and laptop first. nginx basic auth stays on until you remove it.</p>
        <label>
          <input
            type="checkbox"
            checked={state.enforce}
            onChange={async (e) => {
              await act({ action: "set_enforce", on: e.target.checked });
              load();
            }}
          />{" "}
          {state.enforce ? "On" : "Off"}
        </label>
      </section>
    </main>
  );
}
