import { test, expect, request as pwRequest } from "@playwright/test";
import { enableShare, disableShare } from "../src/lib/pages";

// Never presses Send or triggers an agent.
async function scratch(request: import("@playwright/test").APIRequestContext, body: string) {
  const res = await request.post("/api/files", { data: { title: "Share scratch", body, kind: "page" } });
  expect(res.ok()).toBeTruthy();
  const j = await res.json();
  return (j.page?.id ?? j.id) as number;
}

test("share link: public, read-only, revocable, page survives", async ({ page, request, baseURL }) => {
  expect((await request.get("/share/" + "Z".repeat(32))).status()).toBe(404);
  const id = await scratch(request, "Hello shared body\n\n[x](javascript:alert(1))");

  await page.goto(`/files?id=${id}`);
  await page.getByTestId("share-menu").click();
  await page.getByTestId("share-toggle").check();
  const link = await page.getByTestId("share-link").inputValue();
  expect(link).toMatch(/\/share\/[A-Za-z0-9_-]{32}$/);
  const path = new URL(link).pathname;

  const anon = await pwRequest.newContext({ baseURL });
  const ok = await anon.get(path);
  expect(ok.status()).toBe(200);
  const html = await ok.text();
  expect(html).toContain("Share scratch");
  expect(html).toContain("Hello shared body");
  expect(html).not.toContain("<nav");
  expect(html).not.toMatch(/href="javascript:/i);
  expect(ok.headers()["content-security-policy"]).toContain("default-src 'none'");
  expect(ok.headers()["x-robots-tag"]).toContain("noindex");
  expect(ok.headers()["cache-control"]).toContain("no-store");

  await page.getByTestId("share-toggle").uncheck();
  await expect(page.getByText("Link revoked")).toBeVisible();
  expect((await anon.get(path)).status()).toBe(404);
  const still = await request.get(`/api/files/${id}`);
  expect(JSON.stringify(await still.json())).toContain("Hello shared body");

  // trashed after sharing => 404
  const t1 = (await (await request.post(`/api/files/${id}/share`, { data: { enabled: true } })).json()).path as string;
  expect((await anon.get(t1)).status()).toBe(200);
  await request.patch(`/api/files/${id}`, { data: { archive: true } });
  expect((await anon.get(t1)).status()).toBe(404);
  await anon.dispose();
});

test("share rejects folders", async ({ request }) => {
  const res = await request.post("/api/files", { data: { title: "Share folder scratch", kind: "folder" } });
  const j = await res.json();
  const fid = j.page?.id ?? j.id;
  expect((await request.post(`/api/files/${fid}/share`, { data: { enabled: true } })).status()).toBe(400);
});

test("enableShare is idempotent; re-enable issues a new token", async ({ request }) => {
  const id = await scratch(request, "unit");
  const a = enableShare(id);
  expect(enableShare(id)).toBe(a);
  disableShare(id);
  expect(enableShare(id)).not.toBe(a);
  disableShare(id);
});
