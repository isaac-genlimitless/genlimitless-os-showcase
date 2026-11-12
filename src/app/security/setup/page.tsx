"use client";
import { useOwnerName } from "@/components/CellContext";

import { useEffect, useState } from "react";

export default function SecuritySetupPage() {
  const ownerName = useOwnerName();
  const [loaded, setLoaded] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/auth/security")
      .then((r) => r.json())
      .then((d) => setEnrolled(d.enrolled === true))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  async function post(body: Record<string, unknown>) {
    const r = await fetch("/api/auth/setup", {
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

  async function savePassword() {
    setError("");
    if (pw1.length < 12) return setError("Use at least 12 characters.");
    if (pw1 !== pw2) return setError("The two passwords don't match.");
    const { status } = await post({ action: "password", password: pw1 });
    if (status === 200) setStep(2);
    else setError("Could not save the password.");
  }

  async function sendCode() {
    setError("");
    setInfo("");
    const { data } = await post({ action: "send_code" });
    if (data.ok) {
      setInfo("Code sent to your iPhone.");
      setStep(3);
    } else if (data.reason === "cooldown") setError("Wait 30 seconds before asking for another code.");
    else if (data.reason === "rate_limited") setError("Too many codes requested. Try again later.");
    else setError("Could not send the code.");
  }

  async function complete() {
    setError("");
    const { status, data } = await post({ action: "complete", code });
    if (status === 200 && Array.isArray(data.backupCodes)) {
      setBackupCodes(data.backupCodes as string[]);
      setStep(4);
    } else setError("That code is wrong or has expired. Send a new one.");
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(backupCodes.join("\n"));
      setCopied(true);
    } catch {
      setError("Could not copy. Select the codes and copy them by hand.");
    }
  }

  if (!loaded) return <main style={{ padding: 24 }}>Loading…</main>;
  if (enrolled && step !== 4) {
    return (
      <main style={{ maxWidth: 520, margin: "40px auto", padding: 16 }}>
        <h1>Login is already set up</h1>
        <p><a href="/security">Go to security settings</a></p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 520, margin: "40px auto", padding: 16, fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 22 }}>Set up OS login</h1>
      <p style={{ color: "#555" }}>
        Nothing changes until you turn on enforcement in <a href="/security">/security</a>. nginx basic auth
        stays in place until {ownerName} confirms it can be removed.
      </p>

      {step === 1 && (
        <section>
          <h2 style={{ fontSize: 16 }}>1. Choose a password</h2>
          <input type="password" autoComplete="new-password" placeholder="Password (12+ characters)" value={pw1} onChange={(e) => setPw1(e.target.value)} style={{ display: "block", width: "100%", padding: 8, marginBottom: 8 }} />
          <input type="password" autoComplete="new-password" placeholder="Type it again" value={pw2} onChange={(e) => setPw2(e.target.value)} style={{ display: "block", width: "100%", padding: 8, marginBottom: 8 }} />
          <button onClick={savePassword}>Save password</button>
        </section>
      )}

      {step === 2 && (
        <section>
          <h2 style={{ fontSize: 16 }}>2. Test your phone</h2>
          <button onClick={sendCode}>Text me a test code</button>
        </section>
      )}

      {step === 3 && (
        <section>
          <h2 style={{ fontSize: 16 }}>3. Enter the code</h2>
          <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} style={{ display: "block", width: "100%", padding: 8, marginBottom: 8 }} />
          <button onClick={complete} disabled={!code}>Finish setup</button>{" "}
          <button onClick={sendCode}>Send a new code</button>
        </section>
      )}

      {step === 4 && (
        <section>
          <h2 style={{ fontSize: 16 }}>Your backup codes</h2>
          <p>Save these somewhere safe; each works once. They won&apos;t be shown again.</p>
          <pre style={{ background: "#f4f4f4", padding: 12 }}>{backupCodes.join("\n")}</pre>
          <button onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          <p><a href="/security">Go to security settings</a></p>
        </section>
      )}

      {error && <p role="alert" style={{ color: "#b00020" }}>{error}</p>}
      {info && <p>{info}</p>}
    </main>
  );
}
