import { test, expect } from "@playwright/test";

test("runner sends E2E_INTERNAL_TOKEN as x-glos-internal when set", async ({ request }) => {
  const headers = test.info().project.use.extraHTTPHeaders as Record<string, string> | undefined;
  const token = headers?.["x-glos-internal"];
  if (process.env.E2E_INTERNAL_TOKEN) expect(token).toBe(process.env.E2E_INTERNAL_TOKEN);
  expect(token).toMatch(/^[0-9a-f]{64}$/i);
  const res = await request.get("/api/files/graph");
  expect(res.status()).toBe(200);
});
