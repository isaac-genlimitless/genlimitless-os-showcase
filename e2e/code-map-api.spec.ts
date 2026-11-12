import { test, expect } from "@playwright/test";

test("code map API lists backend files and imports", async ({ request }) => {
  const res = await request.get("/api/code-map");
  expect(res.status()).toBe(200);
  const text = await res.text();
  const body = JSON.parse(text);
  expect(body.nodes.length).toBeGreaterThan(50);
  const db = body.nodes.find((n: { id: string }) => n.id === "src/lib/db.ts");
  expect(db).toBeTruthy();
  expect(db.importedBy.length).toBeGreaterThan(0);
  expect(body.nodes.some((n: { id: string }) => n.id.includes(".env"))).toBe(false);
  expect(text).not.toContain("node_modules/");
});
