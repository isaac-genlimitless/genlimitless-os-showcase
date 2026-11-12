export function e2eBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = (env.E2E_BASE_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  return `http://localhost:${env.PORT || 3100}`; // 3100 = the real OS port (README.md:29, ui-snapshot.ts:30); was 3000
}

export function explainTokenRejection(a: { status: number; localFp: string; serverFp: string; body: string; host: string }): string {
  const snippet = (a.body || "").slice(0, 200).replace(/\s+/g, " ");
  if (a.serverFp !== "none" && a.serverFp === a.localFp) return `token accepted by fp but still ${a.status}: session/route issue`;
  if (a.serverFp !== "none") return "MISMATCH: server uses a different AUTH_CODE_SECRET/SESSION_SECRET or data dir";
  if ((a.body || "").includes("login_required")) {
    return "answered by this app's proxy but the request was not seen as loopback (forwarding headers or Host) OR the running build predates the fingerprint header: restart from /opt/genlimitless-os/current";
  }
  return `answered by something other than this app: check what listens on that port (${a.host}; body: ${snippet})`;
}

export function e2eBaseCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const explicit = (env.E2E_BASE_URL || "").trim();
  if (explicit) return [explicit.replace(/\/$/, "")];
  const port = env.PORT || 3100;
  return Array.from(new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://127.0.0.1:3100`]));
}
