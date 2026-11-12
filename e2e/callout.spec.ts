import { test, expect } from "./isolated-test";
import { cleanupFilesPages } from "./test-cleanup";

test.afterEach(() => cleanupFilesPages());

const uniq = () => `callout-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function mk(request: any, data: Record<string, unknown> = {}) {
  const { page } = await (await request.post("/api/files", { data: { title: uniq(), ...data } })).json();
  return page.id as number;
}
const get = async (request: any, id: number) => (await request.get(`/api/files/${id}`)).json();

test("slash /callout, emoji + color, saves and reloads", async ({ page, request }) => {
  const id = await mk(request);
  await page.goto(`/files?id=${id}`);
  await page.locator(".bn-editor").click();
  await page.keyboard.type("/callout");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("callout")).toBeVisible();
  await page.keyboard.type("Hello callout");
  await page.getByTestId("callout-icon").click();
  await page.getByTestId("callout-emoji-option").filter({ hasText: "🔥" }).click();
  await page.getByTestId("callout-icon").click();
  await page.locator('[data-testid="callout-color-option"][data-color="blue"]').click();
  await expect
    .poll(async () => JSON.stringify((await get(request, id)).blocks), { timeout: 15000 })
    .toContain('"color":"blue"');
  const d = await get(request, id);
  const c = d.blocks.find((b: any) => b.type === "callout");
  expect(c.props).toMatchObject({ icon: "🔥", color: "blue" });
  expect(JSON.stringify(c.content)).toContain("Hello callout");
  expect(d.page?.body ?? d.body).toContain("> 🔥 Hello callout");
  await page.reload();
  const box = page.getByTestId("callout");
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute("data-color", "blue");
  await expect(page.getByTestId("callout-icon")).toHaveText("🔥");
  await expect(box).toContainText("Hello callout");
});

test("round trip and markdown import", async ({ request }) => {
  const id = await mk(request);
  const content = [
    { id: "a1", type: "callout", props: { icon: "💡", color: "gray" }, content: [{ type: "text", text: "tip", styles: {} }], children: [] },
    { id: "a2", type: "quote", props: {}, content: [{ type: "text", text: "plain", styles: {} }], children: [] },
  ];
  expect((await request.patch(`/api/files/${id}`, { data: { content } })).ok()).toBeTruthy();
  const d = await get(request, id);
  expect(d.blocks.map((b: any) => b.type)).toEqual(["callout", "quote"]);
  expect(d.page?.body ?? d.body).toContain("> 💡 tip");

  const id2 = await mk(request, { body: "> 💡 imported\n\n> plain quote" });
  const d2 = await get(request, id2);
  const types = d2.blocks.map((b: any) => b.type);
  expect(types).toEqual(["callout", "quote"]);
  expect(d2.blocks[0].props.icon).toBe("💡");

  const before = JSON.stringify((await get(request, id2)).blocks);
  await request.patch(`/api/files/${id2}`, { data: { content: JSON.parse(before) } });
  expect(JSON.stringify((await get(request, id2)).blocks)).toBe(before);
});
