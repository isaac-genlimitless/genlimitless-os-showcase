import { test, expect } from "@playwright/test";

// Read-only: hits the files graph API directly, never touches the UI or agent.

test("GET /api/files/graph returns consistent nodes and edges without bodies", async ({ request }) => {
  const res = await request.get("/api/files/graph");
  expect(res.status()).toBe(200);
  const { nodes, edges, generated_at } = await res.json();
  expect(generated_at).toBeTruthy();
  const ids = new Set<number>(nodes.map((n: { id: number }) => n.id));
  for (const n of nodes) {
    expect(n).not.toHaveProperty("body");
    expect(ids.has(n.top)).toBeTruthy();
  }
  for (const e of edges) {
    expect(ids.has(e.source)).toBeTruthy();
    expect(ids.has(e.target)).toBeTruthy();
    expect(["folder", "link"]).toContain(e.type);
  }
});
