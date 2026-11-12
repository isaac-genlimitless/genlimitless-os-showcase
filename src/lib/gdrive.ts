import fs from "fs";
import path from "path";

// Google Drive integration (OAuth, drive.file scope — the OS can only see files it
// created itself, never the rest of Owner's Drive). Used to host files at a public
// "anyone with the link" URL, e.g. videos to link in emails.

import { DATA_DIR } from "./data-dir";
const TOKEN_FILE = path.join(DATA_DIR, "google-token.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const SCOPE = "https://www.googleapis.com/auth/drive.file";

export class DriveNotConnected extends Error {}

function clientCreds() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret)
    throw new DriveNotConnected(
      "Google Drive isn't set up: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing from .env.local."
    );
  return { id, secret };
}

export function redirectUri(origin: string) {
  return `${origin}/api/google/callback`;
}

export function authUrl(origin: string) {
  const { id } = clientCreds();
  const p = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(code: string, origin: string) {
  const { id, secret } = clientCreds();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      code,
      client_id: id,
      client_secret: secret,
      redirect_uri: redirectUri(origin),
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) throw new Error(`Google token exchange failed: ${JSON.stringify(data)}`);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: data.refresh_token }), { mode: 0o600 });
}

export function isDriveConnected() {
  return fs.existsSync(TOKEN_FILE) && !!process.env.GOOGLE_CLIENT_ID;
}

async function accessToken(): Promise<string> {
  const { id, secret } = clientCreds();
  if (!fs.existsSync(TOKEN_FILE))
    throw new DriveNotConnected("Google Drive isn't connected yet — Owner needs to click Connect Google Drive in Settings.");
  const { refresh_token } = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ refresh_token, client_id: id, client_secret: secret, grant_type: "refresh_token" }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error === "invalid_grant") fs.rmSync(TOKEN_FILE, { force: true });
    throw new DriveNotConnected(`Google Drive access was revoked or expired (${data.error}) — reconnect in Settings.`);
  }
  return data.access_token;
}

const MIME: Record<string, string> = {
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** Resolve a stored upload by its filename (as saved under data/uploads). */
export function uploadPath(filename: string) {
  const p = path.join(UPLOAD_DIR, path.basename(filename));
  if (!fs.existsSync(p)) throw new Error(`No uploaded file named ${filename}`);
  return p;
}

/**
 * Upload a local file to Drive and make it viewable by anyone with the link.
 * Returns the shareable link. Resumable upload, so large videos are fine.
 */
export async function publishToDrive(localPath: string, title?: string) {
  const token = await accessToken();
  const name = title || path.basename(localPath).replace(/^[0-9a-f-]{36}-/, "");
  const mimeType = MIME[path.extname(localPath).toLowerCase()] || "application/octet-stream";
  const size = fs.statSync(localPath).size;

  const init = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(size),
    },
    body: JSON.stringify({ name, mimeType }),
  });
  const session = init.headers.get("location");
  if (!init.ok || !session) throw new Error(`Drive upload init failed: ${init.status} ${await init.text()}`);

  const put = await fetch(session, {
    method: "PUT",
    headers: { "Content-Type": mimeType, "Content-Length": String(size) },
    body: fs.readFileSync(localPath),
  });
  const file = await put.json();
  if (!put.ok) throw new Error(`Drive upload failed: ${put.status} ${JSON.stringify(file)}`);

  const perm = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!perm.ok) throw new Error(`Uploaded, but couldn't make it public: ${perm.status} ${await perm.text()}`);

  const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?fields=id,name,webViewLink`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  return { file_id: meta.id as string, name: meta.name as string, link: meta.webViewLink as string };
}
