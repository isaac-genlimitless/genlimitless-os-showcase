import { test, expect } from "@playwright/test";

test("auth check endpoint rejects requests without a valid session", async ({ request }) => {
  const none = await request.get("/api/auth/check");
  expect(none.status()).toBe(401);
  const bogus = await request.get("/api/auth/check", { headers: { cookie: "glos_session=abc" } });
  expect(bogus.status()).toBe(401);
});
