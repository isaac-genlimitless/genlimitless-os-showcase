import { test, expect } from "@playwright/test";

test("app pages send security headers incl. report-only CSP", async ({ request }) => {
  const res = await request.get("/login");
  const h = res.headers();
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["strict-transport-security"]).toContain("max-age=");
  expect(h["content-security-policy-report-only"]).toContain("object-src 'none'");
  expect(h["content-security-policy-report-only"]).toContain("frame-ancestors 'self'");
});
