import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

// API only. Never presses Send or triggers an agent. Uses scratch pages; page 370 is only read.
const TITLE = "E2E Resume and Cover Letter - Cresta (comments)";

async function scratch(request: APIRequestContext) {
  let body = "Hello commented body. Second sentence here.";
  const src = await request.get("/api/files/370");
  if (src.ok()) {
    const j = await src.json();
    const b = (j.page?.body ?? j.body) as string | undefined;
    if (b) body = b;
  }
  const res = await request.post("/api/files", { data: { title: TITLE, body, kind: "page" } });
  expect(res.ok()).toBeTruthy();
  const j = await res.json();
  const id = (j.page?.id ?? j.id) as number;
  const sh = await (await request.post(`/api/files/${id}/share`, { data: { enabled: true } })).json();
  return { id, body, path: sh.path as string };
}

test("owner comments: create, reply, resolve, reopen, list", async ({ request }) => {
  const { id } = await scratch(request);
  const root = await request.post(`/api/files/${id}/comments`, { data: { quote: "commented", prefix: "Hello ", suffix: " body", start: 6, end: 15, body: "  First  " } });
  expect(root.status()).toBe(200);
  const c = (await root.json()).comment;
  expect(c.source).toBe("owner");
  expect(c.author).toBe("Owner");
  expect(c.body).toBe("First");
  const reply = (await (await request.post(`/api/files/${id}/comments`, { data: { parent_id: c.id, body: "Reply" } })).json()).comment;
  expect(reply.parent_id).toBe(c.id);
  expect(reply.quote).toBe("commented");
  expect((await request.post(`/api/files/${id}/comments`, { data: { parent_id: reply.id, body: "nested" } })).status()).toBe(404);
  expect((await request.post(`/api/files/${id}/comments`, { data: { body: "   " } })).status()).toBe(400);
  expect((await (await request.patch(`/api/files/${id}/comments/${c.id}`, { data: { resolved: true } })).json()).comment.resolved).toBe(true);
  expect((await (await request.patch(`/api/files/${id}/comments/${c.id}`, { data: { resolved: false } })).json()).comment.resolved).toBe(false);
  const list = (await (await request.get(`/api/files/${id}/comments`)).json()).comments;
  expect(list.map((x: { id: number }) => x.id)).toEqual([c.id, reply.id]);
  expect((await request.get("/api/files/99999999/comments")).status()).toBe(404);
  const folder = await (await request.post("/api/files", { data: { title: "Comments folder scratch", kind: "folder" } })).json();
  expect((await request.get(`/api/files/${folder.page?.id ?? folder.id}/comments`)).status()).toBe(400);
});

test("share comments: anonymous create/reply/resolve, guards, caps, notice", async ({ request, baseURL }) => {
  const { id, body, path } = await scratch(request);
  const api = path + "/comments";
  const anon = await pwRequest.newContext({ baseURL });

  const root = await anon.post(api, { data: { author: "Guest Gail", body: "<script>alert(1)</script>", quote: "Hello", start: 0, end: 5, source: "owner" } });
  expect(root.status()).toBe(200);
  expect(root.headers()["cache-control"]).toContain("no-store");
  expect(root.headers()["x-content-type-options"]).toBe("nosniff");
  const c = (await root.json()).comment;
  expect(c.source).toBe("share");
  expect(c.body).toBe("<script>alert(1)</script>");
  expect(Object.keys(c)).not.toContain("ip");

  const reply = (await (await anon.post(api, { data: { author: "Gail", parent_id: c.id, body: "re" } })).json()).comment;
  expect(reply.source).toBe("share");
  expect(reply.quote).toBe("Hello");
  expect((await anon.post(api, { data: { body: "no name" } })).status()).toBe(400);

  const res = await anon.post(`${api}/${c.id}`, { data: { resolved: true, author: "Gail" } });
  expect(res.status()).toBe(200);
  expect((await res.json()).comment.resolved).toBe(true);
  expect((await anon.get(api)).status()).toBe(200);

  // caps
  const big = await anon.post(api, { data: { author: "A".repeat(100), body: "B".repeat(5000), quote: "Q".repeat(3000) } });
  const bc = (await big.json()).comment;
  expect(bc.author).toHaveLength(60);
  expect(bc.body).toHaveLength(2000);
  expect(bc.quote).toHaveLength(1000);

  // non-JSON and oversize
  expect((await anon.post(api, { headers: { "content-type": "text/plain" }, data: "x" })).status()).toBe(415);
  const over = await anon.post(api, { headers: { "content-type": "application/json" }, data: JSON.stringify({ author: "x", body: "y".repeat(9000) }) });
  expect(over.status()).toBe(413);

  // foreign origin
  const foreign = await anon.post(api, { headers: { origin: "https://evil.example" }, data: { author: "x", body: "y" } });
  expect(foreign.status()).toBe(403);

  // owner view: no page body change, owner source never created by public route, fyi notice coalesced
  const after = await (await request.get(`/api/files/${id}`)).json();
  expect(JSON.stringify(after)).toContain(body.slice(0, 40).replace(/\n/g, "\\n").slice(0, 20));
  const list = (await (await request.get(`/api/files/${id}/comments`)).json()).comments as { source: string }[];
  expect(list.every((x) => x.source === "share")).toBe(true);
  const esc = await (await request.get("/api/escalations")).json().catch(() => null);
  if (esc) {
    const items = ((esc.escalations ?? esc) as { title: string; severity: string; from_agent: string }[]).filter((e) => e.title === `New comments on shared file: ${TITLE}`);
    expect(items.length).toBeLessThanOrEqual(1);
    for (const e of items) {
      expect(e.severity).toBe("fyi");
      expect(e.from_agent).toBe("files-comments");
    }
  }
  await anon.dispose();
});

test("share comments: bad, revoked and trashed tokens are 404", async ({ request, baseURL }) => {
  const { id, path } = await scratch(request);
  const anon = await pwRequest.newContext({ baseURL });
  const bad = "/share/" + "Z".repeat(32) + "/comments";
  expect((await anon.get(bad)).status()).toBe(404);
  expect((await anon.post(bad, { data: { author: "x", body: "y" } })).status()).toBe(404);
  expect((await anon.get(path + "/comments")).status()).toBe(200);
  await request.post(`/api/files/${id}/share`, { data: { enabled: false } });
  expect((await anon.get(path + "/comments")).status()).toBe(404);
  expect((await anon.post(path + "/comments", { data: { author: "x", body: "y" } })).status()).toBe(404);
  const again = (await (await request.post(`/api/files/${id}/share`, { data: { enabled: true } })).json()).path as string;
  expect((await anon.get(again + "/comments")).status()).toBe(200);
  await request.patch(`/api/files/${id}`, { data: { archive: true } });
  expect((await anon.get(again + "/comments")).status()).toBe(404);
  await anon.dispose();
});

test("share comments: rate limit is exact (6 per minute, 7th is 429)", async ({ request, baseURL }) => {
  const { path } = await scratch(request);
  const anon = await pwRequest.newContext({ baseURL });
  let ok = 0;
  let last = 0;
  let retry = "";
  for (let i = 0; i < 7; i++) {
    const r = await anon.post(path + "/comments", { data: { author: "Rate", body: "n" + i } });
    last = r.status();
    if (last === 200) ok++;
    else retry = r.headers()["retry-after"] || "";
  }
  expect(ok).toBe(6);
  expect(last).toBe(429);
  expect(Number(retry)).toBeGreaterThan(0);
  await anon.dispose();
});
