import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";

// HTML diagram pages render in a sandboxed iframe. Never presses Send or triggers an agent.

test.afterEach(() => cleanupFilesPages());

const BODY = "```html\n<!DOCTYPE html><html><body><svg id=t></svg><script>window.x=1</script></body></html>\n```";

test("html-diagram page is served sandboxed and shown in a sandboxed iframe", async ({ page, request }) => {
  const title = `E2E Diagram ${Date.now()}`;
  const { page: p } = await (await request.post("/api/files", { data: { title, body: BODY } })).json();
  await request.patch(`/api/files/${p.id}`, { data: { tags: ["html-diagram"] } });

  const res = await request.get(`/api/files/${p.id}/html`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/html");
  expect(res.headers()["content-security-policy"]).toContain("sandbox");
  expect(await res.text()).toContain("<svg");

  await page.goto(`/files?id=${p.id}`);
  const frame = page.getByTestId("html-diagram-frame");
  await expect(frame).toBeVisible({ timeout: 20_000 });
  await expect(frame).toHaveAttribute("sandbox", "");

  const { page: plain } = await (await request.post("/api/files", { data: { title: `E2E Plain ${Date.now()}`, body: BODY } })).json();
  expect((await request.get(`/api/files/${plain.id}/html`)).status()).toBe(404);
});
