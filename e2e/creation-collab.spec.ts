// The Creation with a collaborator (Partner): a private link that opens only her creations, her own sandboxes,
// proposals that wait for Owner, comments, and links Owner can replace or revoke. Writes data: isolated only.
// Never presses Send or triggers an agent.
import { test, expect } from "./isolated-test";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

// Its own creation, so approvals here never race the studio specs' canon version numbers.
let token = "";
let slug = "";
const partner = (path = "") => `/c/${token}/api/creations${path}`;

async function invite(request: APIRequestContext) {
  if (!slug) slug = (await (await request.post("/api/creations", { data: { title: "E2E Collab Lab" } })).json()).creation.slug;
  const r = await request.post(`/api/creations/${slug}/members`, { data: { name: "Partner", role: "collaborator" } });
  expect(r.status()).toBe(200);
  return r.json();
}

test("Owner invites Partner; her link opens only the creations she's on", async ({ request }) => {
  const d = await invite(request);
  expect(d.person.person).toBe("partner");
  expect(d.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  token = d.token;
  // Inviting again keeps her link (no new token).
  expect((await invite(request)).token).toBeNull();

  const list = await (await request.get(partner())).json();
  expect(list.creations.map((c: { slug: string }) => c.slug)).toEqual([slug]);
  expect((await request.get(partner("/farmhouse"))).status()).toBe(404);
  const detail = await (await request.get(partner(`/${slug}`))).json();
  expect(detail.role).toBe("collaborator");
  expect(detail.viewer).toBe("partner");

  expect((await request.get(`/c/${"B".repeat(32)}/api/creations`)).status()).toBe(404);
  const members = await (await request.get(`/api/creations/${slug}/members`)).json();
  expect(members.members.map((m: { person: string }) => m.person)).toEqual(["owner", "partner"]);
});

test("Partner works in her own sandbox, proposes, and only Owner can approve", async ({ request }) => {
  const before = await (await request.get(`/api/creations/${slug}`)).json();
  const sb = await (await request.post(partner(`/${slug}/sandboxes`), { data: { title: "E2E Partner ideas" } })).json();
  expect(sb.sandbox.owner).toBe("partner");
  const save = await request.post(partner(`/sandboxes/${sb.sandbox.id}/artifacts`), { data: { kind: "doc", title: "E2E Partner note", body: "hi" } });
  expect(save.status()).toBe(200);
  const prop = await (await request.post(partner(`/sandboxes/${sb.sandbox.id}/promote`), { data: { rationale: "E2E from Partner" } })).json();
  expect(prop.promotion.proposed_by).toBe("partner");

  // No collaborator route decides a promotion or changes the phase.
  expect((await request.post(`/c/${token}/api/creations/promotions/${prop.promotion.id}`, { data: { decision: "approve" } })).status()).toBe(404);
  expect((await request.patch(partner(`/${slug}`), { data: { phase: "execute" } })).status()).toBe(404);
  const mid = await (await request.get(`/api/creations/${slug}`)).json();
  expect(mid.canon.version.number).toBe(before.canon.version.number);

  // She can't touch Owner's sandbox.
  const mine = await (await request.post(`/api/creations/${slug}/sandboxes`, { data: { title: "E2E Owner's" } })).json();
  const blocked = await request.post(partner(`/sandboxes/${mine.sandbox.id}/artifacts`), { data: { kind: "doc", title: "x" } });
  expect(blocked.status()).toBe(403);
  expect((await request.patch(partner(`/sandboxes/${mine.sandbox.id}`), { data: { action: "archive" } })).status()).toBe(403);
  // ...and Owner doesn't edit hers either: he approves or declines her proposal.
  expect((await request.post(`/api/creations/sandboxes/${sb.sandbox.id}/artifacts`, { data: { kind: "doc", title: "x" } })).status()).toBe(403);

  const ok = await (await request.post(`/api/creations/promotions/${prop.promotion.id}`, { data: { decision: "approve" } })).json();
  expect(ok.promotion.status).toBe("approved");
  expect(ok.promotion.decided_by).toBe("owner");
});

test("comments from both sides; cross-site posts and viewers are refused", async ({ request }) => {
  const c = await (await request.post(partner(`/${slug}/comments`), { data: { body: "E2E what about a barn?" } })).json();
  expect(c.comment.actor).toBe("partner");
  const ownerSees = await (await request.get(`/api/creations/${slug}`)).json();
  expect(ownerSees.feed.find((f: { id: number }) => f.id === c.comment.id).resolved_at).toBeNull();
  expect((await request.post(`/api/creations/feed/${c.comment.id}`, { data: { action: "resolve" } })).status()).toBe(200);

  const cross = await request.post(partner(`/${slug}/comments`), { data: { body: "x" }, headers: { origin: "https://evil.example" } });
  expect(cross.status()).toBe(403);

  const v = await (await request.post(`/api/creations/${slug}/members`, { data: { name: "E2E Viewer", role: "viewer" } })).json();
  const asViewer = await request.post(`/c/${v.token}/api/creations/${slug}/sandboxes`, { data: {} });
  expect(asViewer.status()).toBe(403);
});

test("Partner's page shows only The Creation, and her proposals wait for Owner", async ({ page, request }) => {
  const sb = await (await request.post(partner(`/${slug}/sandboxes`), { data: { title: "E2E Partner UI" } })).json();
  await request.post(partner(`/sandboxes/${sb.sandbox.id}/artifacts`), { data: { kind: "doc", title: "E2E UI note", body: "x" } });
  await request.post(partner(`/sandboxes/${sb.sandbox.id}/promote`), { data: {} });

  await page.goto(`/c/${token}`);
  await expect(page.getByTestId("collab-shell")).toBeVisible();
  await expect(page.locator("aside nav")).toHaveCount(0); // no OS sidebar
  await expect(page.getByTestId(`creation-card-${slug}`)).toBeVisible();
  await expect(page.getByTestId("creation-card-farmhouse")).toHaveCount(0);
  await expect(page.getByTestId("new-creation")).toHaveCount(0);

  await page.getByTestId(`creation-card-${slug}`).click();
  await expect(page).toHaveURL(new RegExp(`/c/${token}/${slug}`));
  await expect(page.getByTestId("members-panel")).toHaveCount(0);
  await expect(page.getByTestId("promotion-approve")).toHaveCount(0);
  await expect(page.getByTestId("promotion-waiting").first()).toBeVisible();
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
});

test("Owner can replace or revoke the link; removed members lose the creation", async ({ request }) => {
  const fresh = await (await request.post("/api/creations/people/partner", { data: { action: "regenerate" } })).json();
  expect((await request.get(partner())).status()).toBe(404); // old link is dead
  token = fresh.token;
  expect((await request.get(partner())).status()).toBe(200);

  await request.post(`/api/creations/${slug}/members`, { data: { action: "remove", person: "partner" } });
  expect((await request.get(partner(`/${slug}`))).status()).toBe(404);
  expect((await (await request.get(partner())).json()).creations).toEqual([]);

  await request.post("/api/creations/people/partner", { data: { action: "revoke" } });
  expect((await request.get(partner())).status()).toBe(404);
});
