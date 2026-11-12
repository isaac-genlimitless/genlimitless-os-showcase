import { test, expect } from "@playwright/test";
import { openTestDb } from "./db-handle";
import db from "../src/lib/db";
import { createPage, updatePage, getPage } from "../src/lib/pages";

test("agent whole-body replace of a populated Owner page is rejected and the body stays intact", async () => {
  openTestDb().close(); // throws unless pointed at the isolated test DB
  const body = "Owner wrote this. ".repeat(30);
  const p = await createPage({ title: unique("Guard"), body, created_by: "owner" });
  await expect(updatePage(p.id, { body: "x" }, { source: "agent" })).rejects.toThrow(/Refused/);
  expect(getPage(p.id)!.body).toBe(body);
  // append is allowed and snapshots a version
  await updatePage(p.id, { body: "More.", append: true }, { source: "agent" });
  const n = db.prepare(`SELECT COUNT(*) c FROM page_versions WHERE page_id = ? AND source = 'agent'`).get(p.id) as { c: number };
  expect(n.c).toBe(1);
});

// API-level: never presses Send or triggers an agent.
const unique = (p: string) => `${p} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function makePage(request: any, body: string) {
  const { page } = await (await request.post("/api/files", { data: { title: unique("History"), body } })).json();
  return page;
}

test("a version row exists after an edit, and restore writes a new version", async ({ request }) => {
  const p = await makePage(request, "# Original\n\nFirst text.");
  const blocks = (await (await request.get(`/api/files/${p.id}`)).json()).blocks;
  expect(blocks.length).toBeGreaterThan(0);
  const edited = await request.patch(`/api/files/${p.id}`, {
    data: { content: [{ type: "paragraph", content: [{ type: "text", text: "Edited text", styles: {} }] }] },
  });
  expect(edited.status()).toBe(200);
  const { versions } = await (await request.get(`/api/files/${p.id}/versions`)).json();
  expect(versions.length).toBeGreaterThanOrEqual(1);
  const restored = await request.post(`/api/files/${p.id}/versions`, { data: { version_id: versions[0].id } });
  expect(restored.status()).toBe(200);
  const after = await (await request.get(`/api/files/${p.id}/versions`)).json();
  expect(after.versions.length).toBeGreaterThan(versions.length - 1);
  expect(after.versions.some((v: any) => v.source === "undo")).toBeTruthy();
});

test("a PATCH with a stale base_updated_at returns 409 and leaves the page alone", async ({ request }) => {
  const p = await makePage(request, "Some content.");
  const stale = await request.patch(`/api/files/${p.id}`, {
    data: { content: [{ type: "paragraph", content: "overwrite" }], base_updated_at: "2000-01-01 00:00:00" },
  });
  expect(stale.status()).toBe(409);
  const view = await (await request.get(`/api/files/${p.id}`)).json();
  expect(JSON.stringify(view.blocks)).not.toContain("overwrite");
  const ok = await request.patch(`/api/files/${p.id}`, {
    data: { content: [{ type: "paragraph", content: "fresh" }], base_updated_at: view.page.updated_at },
  });
  expect(ok.status()).toBe(200);
});
