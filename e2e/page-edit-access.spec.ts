import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import db from "../src/lib/db";
import { enableShare, disableShare } from "../src/lib/pages";
import { decide } from "../src/lib/auth/policy";

// Never presses Send or triggers an agent. Uses isolated scratch pages.
test.describe.configure({ mode: "serial" });

const BODY = "Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.";

async function scratch(request: APIRequestContext, body = BODY) {
  const res = await request.post("/api/files", { data: { title: "Edit access scratch", body, kind: "page" } });
  expect(res.ok()).toBeTruthy();
  const j = await res.json();
  return (j.page?.id ?? j.id) as number;
}
async function enable(request: APIRequestContext, id: number) {
  const res = await request.post(`/api/files/${id}/edit-access`, { data: { action: "enable" } });
  expect(res.status()).toBe(200);
  return (await res.json()).token as string;
}
async function doc(anon: APIRequestContext, token: string) {
  const r = await anon.get(`/edit/${token}/doc`);
  expect(r.status()).toBe(200);
  return (await r.json()) as { title: string; body: string; updated_at: string; csrf: string };
}
function save(anon: APIRequestContext, token: string, d: { updated_at: string; csrf: string }, patch: Record<string, unknown>, headers: Record<string, string> = {}) {
  return anon.post(`/edit/${token}/doc`, {
    headers: { "X-Edit-CSRF": d.csrf, ...headers },
    data: { base_updated_at: d.updated_at, start: 0, end: 5, expected: "Alpha", replacement: "ALPHA", editor: "Tester", ...patch },
  });
}

test("default off, read token never works as edit token, enable needs read share", async ({ request, baseURL }) => {
  const anon = await pwRequest.newContext({ baseURL });
  const id = await scratch(request);
  expect((await request.post(`/api/files/${id}/edit-access`, { data: { action: "enable" } })).status()).toBe(400);
  const read = enableShare(id);
  expect((await anon.get(`/edit/${read}`)).status()).toBe(404);
  expect((await anon.get(`/edit/${"q".repeat(32)}`)).status()).toBe(404);
  const info = await (await request.get(`/api/files/${id}/edit-access`)).json();
  expect(info.enabled).toBe(false);
  const token = await enable(request, id);
  expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(token).not.toBe(read);
  const rows = JSON.stringify(db.prepare(`SELECT * FROM page_edit_access WHERE page_id = ?`).all(id));
  expect(rows).not.toContain(token);
  const shell = await anon.get(`/edit/${token}`);
  expect(shell.status()).toBe(200);
  expect(shell.headers()["content-security-policy"]).toContain("default-src 'none'");
  expect(await shell.text()).not.toContain("Alpha paragraph");
  disableShare(id);
  await anon.dispose();
});

test("valid splice save changes only the body, snapshots, logs, shows last edited", async ({ request, baseURL }) => {
  const anon = await pwRequest.newContext({ baseURL });
  const id = await scratch(request);
  const read = enableShare(id);
  const token = await enable(request, id);
  const before = db.prepare(`SELECT title, parent_id, share_token FROM docs WHERE id = ?`).get(id) as any;
  const versionsBefore = (db.prepare(`SELECT COUNT(*) n FROM page_versions WHERE page_id = ?`).get(id) as any).n;
  const d = await doc(anon, token);
  expect(Object.keys(d).sort()).toEqual(["body", "csrf", "last_edit", "title", "updated_at"]);
  const r = await save(anon, token, d, {});
  expect(r.status()).toBe(200);
  const after = db.prepare(`SELECT title, parent_id, share_token, body FROM docs WHERE id = ?`).get(id) as any;
  expect(after.body).toBe(BODY.replace("Alpha", "ALPHA"));
  expect(after.title).toBe(before.title);
  expect(after.parent_id).toBe(before.parent_id);
  expect(after.share_token).toBe(before.share_token);
  expect((db.prepare(`SELECT COUNT(*) n FROM page_versions WHERE page_id = ?`).get(id) as any).n).toBe(versionsBefore + 1);
  const log = db.prepare(`SELECT editor, prev_body FROM page_edit_log WHERE page_id = ?`).all(id) as any[];
  expect(log.length).toBe(1);
  expect(log[0].editor).toBe("Tester");
  expect(log[0].prev_body).toBe(BODY);
  const html = await (await anon.get(`/share/${read}`)).text();
  expect(html).toContain("Last edited");
  expect(html).toContain("Tester");
  disableShare(id);
  await anon.dispose();
});

test("security checks on save", async ({ request, baseURL }) => {
  const anon = await pwRequest.newContext({ baseURL });
  const id = await scratch(request, "x".repeat(10000));
  enableShare(id);
  const token = await enable(request, id);
  const d = await doc(anon, token);
  const ok = { expected: "xxxxx", replacement: "yyyyy" };
  expect((await anon.post(`/edit/${token}/doc`, { data: { base_updated_at: d.updated_at, start: 0, end: 5, ...ok } })).status()).toBe(403);
  expect((await save(anon, token, d, ok, { "X-Edit-CSRF": "bad" })).status()).toBe(403);
  expect((await save(anon, token, d, ok, { Origin: "https://evil.example" })).status()).toBe(403);
  expect((await anon.post(`/edit/${token}/doc`, { headers: { "X-Edit-CSRF": d.csrf, "Content-Type": "text/plain" }, data: "hello" })).status()).toBe(415);
  expect((await anon.post(`/edit/${token}/doc`, { headers: { "X-Edit-CSRF": d.csrf }, data: { pad: "z".repeat(70000) } })).status()).toBe(413);
  expect((await save(anon, token, d, { ...ok, replacement: "r".repeat(20001) })).status()).toBe(400);
  expect((await save(anon, token, d, { expected: "x".repeat(2600), start: 0, end: 2600, replacement: "" })).status()).toBe(400);
  expect((await save(anon, token, d, { ...ok, base_updated_at: "2000-01-01 00:00:00" })).status()).toBe(409);
  expect((await save(anon, token, d, { expected: "nope!" })).status()).toBe(409);
  for (const m of ["put", "patch", "delete"] as const) expect((await anon[m](`/edit/${token}/doc`, { data: {} })).status()).toBe(405);
  expect((await anon.post(`/edit/${token}/other`, { headers: { "X-Edit-CSRF": d.csrf }, data: {} })).status()).toBe(404);
  expect((await anon.post(`/edit/${token}`, { headers: { "X-Edit-CSRF": d.csrf }, data: {} })).status()).toBe(404);
  disableShare(id);
  await anon.dispose();
});

test("sanitisation of editor text", async ({ request, baseURL }) => {
  const anon = await pwRequest.newContext({ baseURL });
  const id = await scratch(request);
  const read = enableShare(id);
  const token = await enable(request, id);
  const d = await doc(anon, token);
  const evil = "<script>alert(1)</script> [x](javascript:alert(1)) ![p](http://evil/x.png)";
  expect((await save(anon, token, d, { replacement: evil })).status()).toBe(200);
  const body = (db.prepare(`SELECT body FROM docs WHERE id = ?`).get(id) as any).body as string;
  expect(body).not.toContain("<script");
  expect(body.toLowerCase()).not.toContain("javascript:");
  expect(body).not.toContain("![");
  const html = await (await request.get(`/share/${read}`)).text();
  const scripts = html.match(/<script[\s>][^]*?(<\/script>|$)/gi) || [];
  for (const s of scripts) expect(s).toContain(`/share/${read}/comments.js`);
  disableShare(id);
  await anon.dispose();
});

test("revocation paths", async ({ request, baseURL }) => {
  const anon = await pwRequest.newContext({ baseURL });
  const id = await scratch(request);
  enableShare(id);
  const t1 = await enable(request, id);
  await request.post(`/api/files/${id}/edit-access`, { data: { action: "disable" } });
  expect((await anon.get(`/edit/${t1}/doc`)).status()).toBe(404);
  const t2 = await enable(request, id);
  const t3 = (await (await request.post(`/api/files/${id}/edit-access`, { data: { action: "regenerate" } })).json()).token as string;
  expect((await anon.get(`/edit/${t2}/doc`)).status()).toBe(404);
  expect((await anon.get(`/edit/${t3}/doc`)).status()).toBe(200);
  // read sharing off => edit dead, stays dead after re-share
  disableShare(id);
  expect((await anon.get(`/edit/${t3}/doc`)).status()).toBe(404);
  enableShare(id);
  expect((await anon.get(`/edit/${t3}/doc`)).status()).toBe(404);
  // expiry
  const t4 = await enable(request, id);
  expect((await anon.get(`/edit/${t4}/doc`)).status()).toBe(200);
  db.prepare(`UPDATE page_edit_access SET expires_at = ? WHERE page_id = ?`).run(new Date(Date.now() - 1000).toISOString(), id);
  expect((await anon.get(`/edit/${t4}/doc`)).status()).toBe(404);
  expect((await request.post(`/api/files/${id}/edit-access`, { data: { action: "set_expiry", expires_at: new Date(Date.now() - 5000).toISOString() } })).status()).toBe(400);
  // trashed
  const t5 = (await (await request.post(`/api/files/${id}/edit-access`, { data: { action: "regenerate" } })).json()).token as string;
  expect((await anon.get(`/edit/${t5}/doc`)).status()).toBe(200);
  await request.patch(`/api/files/${id}`, { data: { archive: true } });
  expect((await anon.get(`/edit/${t5}/doc`)).status()).toBe(404);
  await anon.dispose();
});

test("restore is reversible", async ({ request, baseURL }) => {
  const anon = await pwRequest.newContext({ baseURL });
  const id = await scratch(request);
  enableShare(id);
  const token = await enable(request, id);
  const d = await doc(anon, token);
  expect((await save(anon, token, d, {})).status()).toBe(200);
  const logId = (db.prepare(`SELECT id FROM page_edit_log WHERE page_id = ?`).get(id) as any).id;
  const versions = (db.prepare(`SELECT COUNT(*) n FROM page_versions WHERE page_id = ?`).get(id) as any).n;
  const res = await request.post(`/api/files/${id}/edit-access`, { data: { action: "restore", log_id: logId } });
  expect(res.status()).toBe(200);
  expect(((db.prepare(`SELECT body FROM docs WHERE id = ?`).get(id) as any).body as string).trim()).toBe(BODY);
  expect((db.prepare(`SELECT COUNT(*) n FROM page_versions WHERE page_id = ?`).get(id) as any).n).toBe(versions + 1);
  disableShare(id);
  await anon.dispose();
});

test("policy: only the edit link paths are public", () => {
  const t = "a".repeat(32);
  const d = (path: string, method: string) =>
    decide({ path, method, headers: { host: "x" }, enrolled: true, enforce: true, breakGlass: false, sessionValid: false });
  for (const p of [`/edit/${t}`, `/edit/${t}/doc`, `/edit/${t}/editor.js`]) {
    expect(d(p, "GET")).toBe("allow");
    expect(d(p, "HEAD")).toBe("allow");
  }
  expect(d(`/edit/${t}/doc`, "POST")).toBe("allow");
  expect(d(`/edit/${t}`, "POST")).not.toBe("allow");
  for (const m of ["PUT", "PATCH", "DELETE"]) expect(d(`/edit/${t}/doc`, m)).not.toBe("allow");
  expect(d(`/edit/${t}/x`, "GET")).not.toBe("allow");
  expect(d(`/edit/short/doc`, "GET")).not.toBe("allow");
  expect(d(`/api/files/1/edit-access`, "GET")).not.toBe("allow");
  expect(d(`/api/files/1/edit-access`, "POST")).not.toBe("allow");
});

test("UI: toggle default off, shows link and expiry, hides when read share off", async ({ page, request }) => {
  const id = await scratch(request);
  await page.goto(`/files?id=${id}`);
  await page.getByTestId("share-menu").click();
  await page.getByTestId("share-toggle").check();
  await expect(page.getByTestId("edit-toggle")).not.toBeChecked();
  await page.getByTestId("edit-toggle").check();
  await expect(page.getByTestId("edit-link")).toHaveValue(/\/edit\/[A-Za-z0-9_-]{32}$/);
  await expect(page.getByTestId("edit-expiry")).toBeVisible();
  await expect(page.getByTestId("edit-regenerate")).toBeVisible();
  await page.getByTestId("share-toggle").uncheck();
  await expect(page.getByTestId("edit-toggle")).toHaveCount(0);
  await expect(page.getByText("Editing is paused too")).toBeVisible();
});

// Last: this exhausts the invalid-token budget for this IP for a minute.
test("rate limits", async ({ request, baseURL }) => {
  const anon = await pwRequest.newContext({ baseURL });
  const id = await scratch(request);
  enableShare(id);
  const token = await enable(request, id);
  const d = await doc(anon, token);
  let limited: Awaited<ReturnType<typeof save>> | null = null;
  for (let i = 0; i < 21; i++) {
    const r = await save(anon, token, d, { start: 0, end: 0, expected: "", replacement: "" });
    if (r.status() === 429) limited = r;
  }
  expect(limited).not.toBeNull();
  expect(limited!.headers()["retry-after"]).toBeTruthy();
  let spam = 0;
  for (let i = 0; i < 40; i++) if ((await anon.get(`/edit/${String.fromCharCode(97 + (i % 26)).repeat(31)}${i % 10}`)).status() === 429) spam++;
  expect(spam).toBeGreaterThan(0);
  disableShare(id);
  await anon.dispose();
});
