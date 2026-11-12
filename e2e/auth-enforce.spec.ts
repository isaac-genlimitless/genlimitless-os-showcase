import { test, expect } from "@playwright/test";
test.skip(!process.env.E2E_START_SERVER, "assumes a not-enrolled/fresh DB — only runs under `npm run test:e2e:branch` (isolated server)");

test("not enrolled: pages load without login and carry security headers", async ({ request }) => {
  const res = await request.get("/");
  expect(res.status()).toBe(200);
  const h = res.headers();
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("SAMEORIGIN");
  expect(h["permissions-policy"]).toContain("microphone=(self)");
});

test("not enrolled: API is not locked out", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
});

test("login page loads", async ({ request }) => {
  const res = await request.get("/login");
  expect(res.status()).toBe(200);
});
