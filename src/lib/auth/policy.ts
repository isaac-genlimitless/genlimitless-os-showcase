import crypto from "crypto";
import { internalSecret } from "./crypto";
import { currentUserId } from "../accounts/identity";
export type HeaderMap = Record<string, string | undefined>;
export type Decision = "allow" | "login_redirect" | "unauthorized" | "forbidden";
export interface PolicyInput { path: string; method: string; headers: HeaderMap; enrolled: boolean; enforce: boolean; breakGlass: boolean; sessionValid: boolean; }
// Browsers (Safari and the home-screen app especially) fetch the tab icons WITHOUT cookies, so they must be public;
// nginx opens the same paths (bridge/nginx-signin.py).
// /api/auth/check and /logout are public on purpose: nginx asks the OWNER cell about every user's cookie, and that cell's
// proxy would otherwise reject any non-owner session before the route ran. check only answers 204/401 for the cookie it is given.
export const PUBLIC_PATHS: readonly string[] = ["/login", "/api/auth/login", "/api/auth/verify", "/api/auth/resend", "/api/auth/invite", "/api/auth/check", "/api/auth/logout", "/favicon.ico", "/icon.png", "/apple-icon.png", "/robots.txt", "/manifest.webmanifest"];
export function toHeaderMap(h: Headers): HeaderMap { const m: HeaderMap = {}; h.forEach((value, key) => { m[key.toLowerCase()] = value; }); return m; }
// Home-screen app icons (public/app-icons/): the phone fetches them while installing, before any login.
const APP_ICON_RE = /^\/app-icons\/[a-z0-9-]+\.png$/;
// One-time setup link (/setup/<token>): the page is public; every secret step is checked against the token in /api/auth/invite.
const SETUP_RE = /^\/setup\/[A-Za-z0-9_-]{43}$/;
export function isPublic(path: string): boolean { return PUBLIC_PATHS.indexOf(path) >= 0 || SETUP_RE.test(path) || path.startsWith("/_next/static/") || APP_ICON_RE.test(path); }
const PROXY_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "x-forwarded-proto"];
export function isLoopback(h: HeaderMap): boolean { return PROXY_HEADERS.every((k) => !h[k]) && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h["host"] || ""); }
export const INTERNAL_HEADER = "x-glos-internal";
// Per cell AND per user: derived from this cell's own internal-secret.key (never the shared auth secret), so no cell can
// compute, or be fooled by, another cell's token.
export function internalTokenFor(userId: string, dataDir?: string): string { return crypto.createHmac("sha256", internalSecret(dataDir)).update("internal:" + userId).digest("hex"); }
export function internalToken(dataDir?: string): string { return internalTokenFor(currentUserId(), dataDir); }
// Non-secret diagnostic: first 8 hex chars of sha256 of the internal token (one-way), to compare secrets across processes.
export function tokenFingerprint(token: string = internalToken()): string { return crypto.createHash("sha256").update(token).digest("hex").slice(0, 8); }
export const FINGERPRINT_HEADER = "x-glos-fp";
export function hasInternalToken(h: HeaderMap, dataDir?: string): boolean {
  const got = h[INTERNAL_HEADER];
  if (!got) return false;
  const exp = internalToken(dataDir);
  const a = Buffer.from(got);
  const b = Buffer.from(exp);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Loopback skips login only with the internal token; the health probe stays token-free for the deploy healthcheck.
// (/api/schools used to be here too, but it returns real data; glos-deploy must probe /api/health.)
const HEALTH_PATHS = new Set(["/api/health"]);
export function loopbackAllowed(h: HeaderMap, method: string, path: string): boolean {
  if (!isLoopback(h)) return false;
  if (method.toUpperCase() === "GET" && HEALTH_PATHS.has(path)) return true;
  return hasInternalToken(h);
}
export function sameOrigin(h: HeaderMap): boolean { const o = h["origin"]; if (o) { try { return new URL(o).host === (h["x-forwarded-host"] || h["host"]); } catch { return false; } } return h["sec-fetch-site"] !== "cross-site"; }
export function isDeployProbe(env: Record<string, string | undefined>, method: string, path: string): boolean {
  return env.PORT === "3101" && env.DISABLE_SCHEDULER === "1" && env.GLOS_TEST_SERVER === "1" && method === "GET" && HEALTH_PATHS.has(path);
}
const SHARE_READ_RE = /^\/share\/[A-Za-z0-9_-]{32}(\/comments|\/comments\.js)?$/;
const SHARE_WRITE_RE = /^\/share\/[A-Za-z0-9_-]{32}\/comments(\/[0-9]{1,12})?$/;
const EDIT_READ_RE = /^\/edit\/[A-Za-z0-9_-]{32}(\/doc|\/editor\.js)?$/;
const EDIT_WRITE_RE = /^\/edit\/[A-Za-z0-9_-]{32}\/doc$/;
export function isPublicShare(path: string, method: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return SHARE_READ_RE.test(path) || EDIT_READ_RE.test(path);
  if (m === "POST") return SHARE_WRITE_RE.test(path) || EDIT_WRITE_RE.test(path);
  return false;
}
// The Creation's collaborator links (/c/<token>/...): the route itself checks the token (src/lib/creations/people.ts)
// and only ever opens the creations that person is a member of. Never reaches any other part of the OS.
const COLLAB_RE = /^\/c\/[A-Za-z0-9_-]{32}(\/[A-Za-z0-9_-]+){0,6}$/;
export function isCollabPath(path: string, method: string): boolean {
  const m = method.toUpperCase();
  return (m === "GET" || m === "HEAD" || m === "POST" || m === "PATCH") && COLLAB_RE.test(path);
}
// The job-engine posts here with no session; the route rejects anything without a valid HMAC signature (src/lib/job-engine/inbox.ts).
export function isJobEngineInbox(path: string, method: string): boolean { return method.toUpperCase() === "POST" && path === "/api/job-engine/inbox"; }
export function decide(i: PolicyInput): Decision {
  if (i.breakGlass || !i.enrolled || !i.enforce) return "allow";
  if (loopbackAllowed(i.headers, i.method, i.path) || isPublic(i.path) || isPublicShare(i.path, i.method) || isCollabPath(i.path, i.method) || isJobEngineInbox(i.path, i.method)) return "allow";
  if (!i.sessionValid) return i.path.startsWith("/api/") ? "unauthorized" : "login_redirect";
  const m = i.method.toUpperCase();
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && !sameOrigin(i.headers)) return "forbidden";
  return "allow";
}
