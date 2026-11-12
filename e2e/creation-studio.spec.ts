// The Creation: canon is read-only; anything changes only via sandbox → proposal → owner approval.
// Tests never press Send or trigger an agent.
import { test as readTest, expect as readExpect } from "@playwright/test";
import { test, expect } from "./isolated-test";

// These share one creation's canon (version numbers), so run them in order, not in parallel.
readTest.describe.configure({ mode: "serial" });
const STAGE2 = "Starter: site economics + structure map";
const STAGE3 = "Starter: Location Lab";

readTest("Creations home lists the pilot first and the workspace opens canon read-only", async ({ page }) => {
  await page.goto("/the-creation");
  await readExpect(page.getByTestId("creation-tab-studio")).toHaveAttribute("aria-selected", "true");
  const cards = page.locator("[data-testid^='creation-card-']");
  await readExpect(cards.first()).toHaveAttribute("data-testid", "creation-card-creation-system");
  await readExpect(page.getByTestId("creation-card-farmhouse")).toBeVisible();
  await readExpect(page.getByTestId("creation-card-dreamhouse")).toBeVisible();

  await page.getByTestId("creation-card-creation-system").click();
  await readExpect(page).toHaveURL(/\/the-creation\/creation-system/);
  await readExpect(page.getByTestId("view-canon")).toHaveAttribute("aria-selected", "true");
  await readExpect(page.getByTestId("artifact-list")).toContainText("Physical location");
  await readExpect(page.getByTestId("artifact-edit")).toHaveCount(0); // canon has no Edit button
  await readExpect(page.getByTestId("phase-strip")).toContainText("Tear down");
});

readTest("canon has no write route, and spaces may only embed this app's own /api/ routes", async ({ request }) => {
  const put = await request.put("/api/creations/creation-system", { data: { title: "x" } });
  readExpect([404, 405]).toContain(put.status());
  const bad = await request.get("/api/creations/does-not-exist");
  readExpect(bad.status()).toBe(404);
  const farm = await (await request.get("/api/creations/farmhouse")).json();
  readExpect(farm.canon.artifacts[0].data.src).toBe("/api/farmhouse/refined");
});

test("stage-2 starter material arrives as a pending proposal, and approving puts the model + map in canon", async ({ page, request }) => {
  const before = await (await request.get("/api/creations/creation-system")).json();
  expect(before.canon.artifacts.map((a: { key: string }) => a.key)).not.toContain("site-economics");
  const starter = before.promotions.find((p: { sandbox_title: string; status: string }) => p.sandbox_title === STAGE2 && p.status === "pending");
  expect(starter).toBeTruthy();
  expect(starter.changes.map((c: { key: string }) => c.key).sort()).toEqual(["site-economics", "structure-map"]);

  await page.goto("/the-creation/creation-system");
  await page.getByTestId(`promotion-${starter.id}`).getByTestId("promotion-approve").click();
  await expect(page.getByTestId("artifact-list")).toContainText("Site economics");
  const after = await (await request.get("/api/creations/creation-system")).json();
  expect(after.canon.version.number).toBe(before.canon.version.number + 1);
  // The one-off starter sandbox archives itself once its work is in canon.
  expect(after.sandboxes.map((x: { title: string }) => x.title)).not.toContain(STAGE2);

  // Queued once only: a reload does not queue it again.
  const again = await (await request.get("/api/creations/creation-system")).json();
  expect(again.promotions.filter((p: { sandbox_title: string; status: string }) => p.sandbox_title === STAGE2 && p.status === "pending")).toHaveLength(0);

  // The map renders and shows connections.
  await page.getByTestId("artifact-list").getByText("Structure map").click();
  await page.getByTestId("map-node-services-wing").click();
  await expect(page.getByTestId("map-detail")).toContainText("Tenant rent");
});

test("stage-3 Location Lab: approve it, then the plan, clock, 3D view and site finder work", async ({ page, request }) => {
  const before = await (await request.get("/api/creations/creation-system")).json();
  const lab = before.promotions.find((p: { sandbox_title: string; status: string }) => p.sandbox_title === STAGE3 && p.status === "pending");
  expect(lab.changes.map((c: { key: string }) => c.key).sort()).toEqual(["site-finder", "site-plan"]);

  await page.goto("/the-creation/creation-system");
  await page.getByTestId(`promotion-${lab.id}`).getByTestId("promotion-approve").click();
  await expect(page.getByTestId("artifact-list")).toContainText("Location Lab: site finder");
  const after = await (await request.get("/api/creations/creation-system")).json();
  const canonId = after.canon.version.id;

  // Plan: 2D, utilization numbers, clock.
  await page.getByTestId("artifact-list").getByText("Location Lab: Creation Center prototype").click();
  await expect(page.getByTestId("plan-2d")).toContainText("Family-services wing");
  await expect(page.getByTestId("plan-sqft")).toContainText("13,400 sq ft");
  await expect(page.getByTestId("plan-clock").locator("td")).toHaveCount(7 * 24);
  await page.getByTestId("plan-tab-3d").click();
  await expect(page.getByTestId("plan-3d-frame")).toHaveAttribute("src", `/api/creations/site3d/v${canonId}/site-plan`);
  await expect(page.getByTestId("plan-3d-frame")).toHaveAttribute("sandbox", "allow-scripts");

  // The 3D route serves an isolated page; bad refs and non-plan artifacts are 404.
  const r = await request.get(`/api/creations/site3d/v${canonId}/site-plan`);
  expect(r.status()).toBe(200);
  expect(r.headers()["content-security-policy"]).toContain("sandbox");
  expect(await r.text()).toContain("Family-services wing");
  expect((await request.get(`/api/creations/site3d/v${canonId}/vision`)).status()).toBe(404);
  expect((await request.get(`/api/creations/site3d/x1/site-plan`)).status()).toBe(404);

  // Site finder: ranking shows; a weight what-if in canon reorders but is not saved.
  await page.getByTestId("artifact-list").getByText("Location Lab: site finder").click();
  const ranking = page.getByTestId("sites-ranking");
  await expect(ranking.locator("li")).toHaveCount(5);
  const firstBefore = await ranking.locator("li").first().getAttribute("data-testid");
  await page.getByTestId("weight-cost").fill("0");
  await page.getByTestId("weight-acreage").fill("0");
  await page.getByTestId("weight-homeschool").fill("5");
  await expect(page.getByTestId("sites-reset")).toBeVisible();
  const canon = await (await request.get("/api/creations/creation-system")).json();
  expect(canon.canon.artifacts.find((a: { key: string }) => a.key === "site-finder").data.criteria.find((c: { key: string }) => c.key === "cost").weight).toBe(5);
  expect(firstBefore).toBeTruthy();
});

test("model: a what-if in canon is not saved; the same change in a sandbox is", async ({ page, request }) => {
  await page.goto("/the-creation/creation-system?a=site-economics");
  await expect(page.getByTestId("model-view")).toBeVisible();
  const net = page.getByTestId("kpi-net");
  const netBefore = await net.innerText();
  await page.getByTestId("input-microschool_students").fill("200");
  await expect(net).not.toHaveText(netBefore);
  await expect(page.getByTestId("model-reset")).toBeVisible();
  const canon = await (await request.get("/api/creations/creation-system")).json();
  expect(canon.canon.artifacts.find((a: { key: string }) => a.key === "site-economics").data.inputs.microschool_students).toBe(120);

  page.once("dialog", (d) => d.accept("E2E model sandbox"));
  await page.getByTestId("new-sandbox").click();
  await expect(page).toHaveURL(/sandbox=\d+/);
  const sid = Number(new URL(page.url()).searchParams.get("sandbox"));
  await page.getByTestId("input-microschool_students").fill("150");
  await expect(page.getByTestId("model-status")).toHaveText("Saved to sandbox");
  const sb = await (await request.get(`/api/creations/sandboxes/${sid}`)).json();
  expect(sb.artifacts.find((a: { key: string }) => a.key === "site-economics").data.inputs.microschool_students).toBe(150);
  expect(sb.changes.map((c: { key: string }) => c.key)).toEqual(["site-economics"]);
});

test("model and map artifacts are validated server-side", async ({ request }) => {
  const c = await (await request.post("/api/creations", { data: { title: "E2E Validation" } })).json();
  const sb = await (await request.post(`/api/creations/${c.creation.slug}/sandboxes`, { data: {} })).json();
  const url = `/api/creations/sandboxes/${sb.sandbox.id}/artifacts`;
  expect((await request.post(url, { data: { kind: "model", title: "m", data: { engine: "nope" } } })).status()).toBe(400);
  const ok = await (await request.post(url, { data: { kind: "model", title: "m", data: { engine: "site-pnl", inputs: { microschool_students: 99999 } } } })).json();
  expect(ok.artifact.data.inputs.microschool_students).toBe(2000);
  expect((await request.post(url, { data: { kind: "map", title: "x", data: { columns: [{ title: "A", nodes: [{ id: "a", label: "A" }] }], edges: [{ from: "a", to: "b" }] } } })).status()).toBe(400);
});

test("sandbox edit → propose → approve makes a new canon version; canon is untouched until then", async ({ page, request }) => {
  const before = await (await request.get("/api/creations/creation-system")).json();
  const v = before.canon.version.number;

  // Make a sandbox through the UI.
  await page.goto("/the-creation/creation-system");
  page.once("dialog", (d) => d.accept("E2E sandbox"));
  await page.getByTestId("new-sandbox").click();
  await expect(page).toHaveURL(/sandbox=\d+/);
  const sandboxId = Number(new URL(page.url()).searchParams.get("sandbox"));
  await expect(page.getByTestId("sandbox-bar")).toBeVisible();

  // Edit the vision doc in the sandbox.
  await page.getByTestId("artifact-list").getByText("Vision: Real and Ideal").click();
  await page.getByTestId("artifact-edit").click();
  await page.getByTestId("artifact-body-input").fill("E2E rewritten vision");
  await page.getByTestId("artifact-save").click();
  await expect(page.getByTestId("artifact-pane")).toContainText("E2E rewritten vision");

  // Canon is still the old text.
  const mid = await (await request.get("/api/creations/creation-system")).json();
  expect(mid.canon.version.number).toBe(v);
  expect(mid.canon.artifacts.find((x: { key: string }) => x.key === "vision").body).not.toContain("E2E rewritten vision");

  // Propose and approve.
  await page.getByTestId("propose-open").click();
  await page.getByTestId("propose-rationale").fill("E2E: sharper vision");
  await page.getByTestId("propose-submit").click();
  const card = page.locator("[data-testid^='promotion-']").filter({ hasText: "E2E sandbox" });
  await expect(card).toContainText("E2E sandbox");
  await card.getByTestId("promotion-approve").click();
  await expect(page.getByTestId("view-canon")).toContainText(`Canon v${v + 1}`);

  const after = await (await request.get("/api/creations/creation-system")).json();
  expect(after.canon.version.number).toBe(v + 1);
  expect(after.canon.artifacts.find((x: { key: string }) => x.key === "vision").body).toContain("E2E rewritten vision");
  // The old version is still readable.
  const old = before.versions[0].id;
  const oldV = await (await request.get(`/api/creations/versions/${old}`)).json();
  expect(oldV.artifacts.find((x: { key: string }) => x.key === "vision").body).not.toContain("E2E rewritten vision");

  // Re-proposing the same sandbox with no new edits is refused.
  const again = await request.post(`/api/creations/sandboxes/${sandboxId}/promote`, { data: {} });
  expect(again.status()).toBe(400);
});

test("declined proposals leave canon alone; archived sandboxes refuse edits; bad spaces are rejected", async ({ request }) => {
  const c = await (await request.post("/api/creations", { data: { title: "E2E Kitchen appliance" } })).json();
  const slug = c.creation.slug;
  const sb = await (await request.post(`/api/creations/${slug}/sandboxes`, { data: { title: "E2E try" } })).json();
  const id = sb.sandbox.id;

  const evil = await request.post(`/api/creations/sandboxes/${id}/artifacts`, { data: { kind: "space", title: "x", data: { src: "https://evil.example/" } } });
  expect(evil.status()).toBe(400);

  const add = await request.post(`/api/creations/sandboxes/${id}/artifacts`, { data: { kind: "doc", title: "E2E Mechanism", body: "gears" } });
  expect(add.status()).toBe(200);
  const p = await (await request.post(`/api/creations/sandboxes/${id}/promote`, { data: { rationale: "E2E" } })).json();
  expect(p.promotion.changes[0].op).toBe("add");
  const dec = await request.post(`/api/creations/promotions/${p.promotion.id}`, { data: { decision: "decline" } });
  expect((await dec.json()).promotion.status).toBe("declined");
  const twice = await request.post(`/api/creations/promotions/${p.promotion.id}`, { data: { decision: "approve" } });
  expect(twice.status()).toBe(400);
  const detail = await (await request.get(`/api/creations/${slug}`)).json();
  expect(detail.canon.version.number).toBe(1);
  expect(detail.canon.artifacts.map((x: { key: string }) => x.key)).toEqual(["vision"]);

  await request.patch(`/api/creations/sandboxes/${id}`, { data: { action: "archive" } });
  const late = await request.post(`/api/creations/sandboxes/${id}/artifacts`, { data: { kind: "doc", title: "late" } });
  expect(late.status()).toBe(400);
});
